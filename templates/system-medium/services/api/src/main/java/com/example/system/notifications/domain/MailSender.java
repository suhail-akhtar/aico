package com.example.system.notifications.domain;

/**
 * Port: send one email. An implementation throws an unchecked exception when the mail could not be
 * handed over; the caller lets it propagate, which rolls the handling back and leaves the event in
 * the outbox for the worker to retry.
 */
public interface MailSender {

  void send(Mail mail);
}
