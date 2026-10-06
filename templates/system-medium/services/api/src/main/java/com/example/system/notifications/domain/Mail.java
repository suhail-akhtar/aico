package com.example.system.notifications.domain;

/**
 * A plain-text email. Plain text on purpose: there is no markup to inject into, and no template
 * engine to misconfigure. Addresses and the subject are validated by the code that builds a mail,
 * never taken from a client unchecked.
 */
public record Mail(String to, String subject, String body) {}
