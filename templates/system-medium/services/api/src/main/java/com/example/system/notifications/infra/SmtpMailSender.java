package com.example.system.notifications.infra;

import com.example.system.notifications.domain.Mail;
import com.example.system.notifications.domain.MailSender;
import com.example.system.shared.config.AppProperties;
import jakarta.mail.MessagingException;
import java.nio.charset.StandardCharsets;
import org.springframework.mail.MailSendException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Component;

/**
 * Adapter: sends through SMTP (Mailpit locally, a relay in production). Connection, read and write
 * timeouts are set in {@code application.properties}, so a stalled relay fails the attempt instead
 * of holding a thread; the failure propagates and the outbox retries.
 */
@Component
class SmtpMailSender implements MailSender {

  private final JavaMailSender mailer;
  private final String from;

  SmtpMailSender(JavaMailSender mailer, AppProperties props) {
    this.mailer = mailer;
    this.from = props.mail().from();
  }

  @Override
  public void send(Mail mail) {
    try {
      var message = mailer.createMimeMessage();
      var helper = new MimeMessageHelper(message, false, StandardCharsets.UTF_8.name());
      helper.setFrom(from);
      helper.setTo(mail.to());
      helper.setSubject(mail.subject());
      helper.setText(mail.body(), false);
      mailer.send(message);
    } catch (MessagingException e) {
      throw new MailSendException("Could not build the message", e);
    }
  }
}
