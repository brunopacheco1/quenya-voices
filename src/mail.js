// SPDX-FileCopyrightText: 2026 Bruno Pacheco (https://bruno.pacheco.lu)
// SPDX-License-Identifier: Apache-2.0

// Sends the sign-in codes, through the SMTP server in SMTP_HOST (with SMTP_PORT, SMTP_USER, SMTP_PASSWORD and
// MAIL_FROM). Without SMTP_HOST, for local development only, the e-mail is printed instead.

import nodemailer from "nodemailer";

export function mailerFromEnvironment(env) {
  if (!env.SMTP_HOST) {
    if (env.NODE_ENV === "production") throw new Error("SMTP_HOST is not set: sign-in codes cannot be sent");
    return async ({ to, subject, text }) => console.log(`\n[mail to ${to}] ${subject}\n${text}\n`);
  }
  const port = Number(env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465, // 587 and 25 upgrade with STARTTLS, which requireTLS makes mandatory
    requireTLS: port !== 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return async ({ to, subject, text }) => {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
  };
}
