package com.example.system.support;

import com.example.system.notifications.domain.Mail;
import com.example.system.notifications.domain.MailSender;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A mail sender for tests: records what was sent and can be told to fail the next N attempts, which
 * is how the retry path of the outbox is exercised without a real SMTP outage.
 */
public final class RecordingMailSender implements MailSender {

  private final List<Mail> sent = new CopyOnWriteArrayList<>();
  private final AtomicInteger failures = new AtomicInteger();

  @Override
  public void send(Mail mail) {
    if (failures.getAndUpdate(n -> n > 0 ? n - 1 : 0) > 0) {
      throw new IllegalStateException("SMTP is down (simulated)");
    }
    sent.add(mail);
  }

  public void failNext(int attempts) {
    failures.set(attempts);
  }

  public List<Mail> sentTo(String address) {
    return sent.stream().filter(m -> m.to().equals(address)).toList();
  }

  public void clear() {
    sent.clear();
    failures.set(0);
  }
}
