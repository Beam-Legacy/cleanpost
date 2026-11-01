import nodemailer, { type Transporter } from 'nodemailer';
import { emailEnvSchema, parseEnv } from '@cleanpost/config';
import { createLogger } from '@cleanpost/log';
import type { EmailContent } from './layout';

const log = createLogger({ name: 'email' });

export type TemplateId = 'E-01' | 'E-02' | 'E-03' | 'E-04' | 'E-05' | 'E-06' | 'E-07';

export interface Mailer {
  send(to: string, template: TemplateId, content: EmailContent): Promise<void>;
}

export function createSmtpMailer(env = parseEnv(emailEnvSchema)): Mailer {
  if (env.SMTP_HOST === 'log') return logOnlyMailer();
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return transportMailer(transport, env.EMAIL_FROM);
}

export function transportMailer(transport: Transporter, from: string): Mailer {
  return {
    async send(to, template, content) {
      const info = await transport.sendMail({
        from,
        to,
        subject: content.subject,
        html: content.html,
        text: content.text,
        headers: { 'X-Cleanpost-Template': template },
      });
      // Recipient addresses are not logged; the template ID and provider message ID are enough to trace.
      log.info({ template, messageId: info.messageId }, 'email sent');
    },
  };
}

export interface SentEmail {
  to: string;
  template: TemplateId;
  content: EmailContent;
}

/** Collects emails in memory instead of sending them (tests and local scripts). */
export function memoryMailer(): Mailer & { sent: SentEmail[] } {
  const sent: SentEmail[] = [];
  return {
    sent,
    async send(to, template, content) {
      sent.push({ to, template, content });
    },
  };
}

/** For environments without a mail server (preview): records that an email would have gone out, nothing else. */
export function logOnlyMailer(): Mailer {
  return {
    async send(_to, template) {
      log.info({ template }, 'email not sent (SMTP_HOST=log)');
    },
  };
}
