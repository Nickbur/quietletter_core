import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { formatZonedTime, isRussian } from './timezone.js';

/**
 * SMTP transport with a dev-console fallback. When EMAIL_DEV_MODE=true, or no
 * SMTP_HOST is configured, mail is printed to the console instead of sent — so a
 * self-hosted instance warns + fires end-to-end out of the box with no provider.
 * Configure SMTP_* to deliver real mail.
 *
 * The core ships NO push (OneSignal) or SMS (Twilio) integration by design: those
 * channels are logged to the console so a self-hoster can wire their own provider
 * without the core carrying third-party SDKs. Email is the channel that works
 * standalone, and it is the one that actually carries the release link.
 */
let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
    if (env.EMAIL_DEV_MODE || !env.SMTP_HOST) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE,
            auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        });
    }
    return transporter;
}

interface SendOpts {
    to: string;
    subject: string;
    html: string;
    text: string;
}

async function send({ to, subject, html, text }: SendOpts): Promise<void> {
    const tx = getTransporter();
    if (!tx) {
        // eslint-disable-next-line no-console
        console.log(`\n[email:dev] → ${to}\n  subject: ${subject}\n  ${text}\n`);
        return;
    }
    await tx.sendMail({ from: env.MAIL_FROM, to, subject, html, text });
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shell(inner: string): string {
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">${inner}</div>`;
}

/**
 * Quietletter check-in warning to the SWITCH OWNER. Sent by the sweep during the grace
 * window: the deadline has passed and the switch will fire at `firesAt` unless the
 * owner proves they are still around. `firesAt` is shown on the switch's own clock
 * (`timeZone`; UTC for a switch saved before switches carried a zone).
 */
export async function sendWarningEmail(
    to: string,
    opts: {
        title: string;
        firesAt: Date;
        timeZone: string | null;
        checkinUrl: string;
        /** The switch's language — Russian for `ru`, else English. */
        locale?: string | null;
    },
): Promise<void> {
    const ru = isRussian(opts.locale);
    const when = formatZonedTime(opts.firesAt, opts.timeZone, ru ? 'ru' : 'en');
    const c = ru
        ? {
              subject: `Отметьтесь, чтобы «${opts.title}» не сработал`,
              text: `Ваш переключатель Quietletter «${opts.title}» ждёт отметки.\nЕсли вы не отметитесь, он сработает ${when}.\nОтметьтесь в приложении Quietletter (инстанс: ${opts.checkinUrl}).`,
              label: 'Нужна отметка',
              lead: `Ваш переключатель ждёт отметки. Если вы не отметитесь, он сработает <b>${when}</b>.`,
              open: 'Откройте приложение Quietletter, чтобы отметиться. Инстанс:',
              note: 'Если вы этого не ожидали, проверьте переключатель.',
          }
        : {
              subject: `Check in to keep "${opts.title}" from firing`,
              text: `Your Quietletter switch "${opts.title}" is waiting for a check-in.\nIf you don't check in, it will fire on ${when}.\nCheck in from your Quietletter client (instance: ${opts.checkinUrl}).`,
              label: 'Check-in needed',
              lead: `Your switch is waiting for a check-in. If you don't check in, it will fire on <b>${when}</b>.`,
              open: 'Open your Quietletter client to check in. Instance:',
              note: "If this wasn't expected, review your switch.",
          };
    await send({
        to,
        subject: c.subject,
        text: c.text,
        html: shell(
            `<p style="color:#b45309;font-size:13px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px">${c.label}</p>` +
                `<h2 style="margin:0 0 8px">${escapeHtml(opts.title)}</h2>` +
                `<p style="color:#444;margin:0 0 12px">${c.lead}</p>` +
                `<p style="color:#444;margin:0 0 12px">${c.open} <a href="${opts.checkinUrl}" style="color:#2563eb">${opts.checkinUrl}</a></p>` +
                `<p style="color:#888;font-size:13px">${c.note}</p>`,
        ),
    });
}

/** One readable message of a fired switch: the owner's optional Subject + the text. */
export interface ReadableMessage {
    subject?: string | null;
    body: string;
}

/**
 * Quietletter fire notification to a RECIPIENT. Carries any readable messages inline
 * (each under its Subject, when it has one), a link to the release page for encrypted
 * items (where the recipient enters the passphrase the owner shared out-of-band), and
 * any public-page URLs that went live. The server never sees the passphrase or the
 * encrypted content. Written in
 * the switch's language — the closest guess at the recipients' (they have no account).
 */
export async function sendFireEmail(
    to: string,
    opts: {
        switchTitle: string;
        recipientName?: string | null;
        readableMessages?: ReadableMessage[];
        releaseUrl?: string | null;
        publicUrls?: string[];
        /** The switch's language — Russian for `ru`, else English. */
        locale?: string | null;
    },
): Promise<void> {
    const ru = isRussian(opts.locale);
    const name = opts.recipientName;
    const c = ru
        ? {
              hello: name ? `Здравствуйте, ${name},` : 'Здравствуйте,',
              subject: `Вам кое-что оставили: ${opts.switchTitle}`,
              heading: 'Вам кое-что оставили',
              intro: `Это было подготовлено заранее через Quietletter («${opts.switchTitle}») и передано вам сейчас.`,
              textIntro: `Через Quietletter («${opts.switchTitle}») для вас кое-что оставили.`,
              releaseLead: 'Для вас защищённо оставлены материалы. Откройте их здесь:',
              releaseCta: 'Открыть то, что вам оставили',
              releaseNote:
                  'Понадобится парольная фраза, которую вам передал отправитель. Мы не можем прочитать содержимое и не можем восстановить фразу.',
              releaseText: (url: string) =>
                  `Откройте защищённые материалы здесь: ${url} (понадобится парольная фраза, которую вам передал отправитель).`,
              publicLead: 'Опубликованы публичные страницы:',
              publicText: 'Публичные страницы:',
          }
        : {
              hello: name ? `Hello ${name},` : 'Hello,',
              subject: `Something was left for you: ${opts.switchTitle}`,
              heading: 'Something was left for you',
              intro: `This was set up in advance through Quietletter ("${opts.switchTitle}") and released to you now.`,
              textIntro: `Something was left for you through Quietletter ("${opts.switchTitle}").`,
              releaseLead: 'Some items were left for you securely. Open them here:',
              releaseCta: 'Open what was left for you',
              releaseNote:
                  "You'll need the passphrase the sender shared with you. We can't read the content and can't recover the passphrase.",
              releaseText: (url: string) =>
                  `Open the secure items here: ${url} (you'll need the passphrase the sender shared with you).`,
              publicLead: 'Public pages were published:',
              publicText: 'Public pages:',
          };
    const messages = (opts.readableMessages ?? [])
        .filter((m) => m.body && m.body.trim())
        .map((m) => ({ subject: m.subject?.trim() || null, body: m.body }));
    const messagesHtml = messages
        .map(
            (m) =>
                (m.subject
                    ? `<p style="color:#111;font-weight:600;margin:16px 0 0">${escapeHtml(m.subject)}</p>`
                    : '') +
                `<div style="border-left:3px solid #e5e7eb;padding:4px 0 4px 12px;margin:${m.subject ? '4px' : '12px'} 0 12px;color:#444;white-space:pre-wrap">${escapeHtml(m.body)}</div>`,
        )
        .join('');
    const releaseHtml = opts.releaseUrl
        ? `<p style="color:#444;margin:16px 0 4px">${c.releaseLead}</p>` +
          `<p style="margin:4px 0 16px"><a href="${opts.releaseUrl}" style="color:#2563eb;font-weight:600">${c.releaseCta}</a></p>` +
          `<p style="color:#888;font-size:13px">${c.releaseNote}</p>`
        : '';
    const publicUrls = (opts.publicUrls ?? []).filter(Boolean);
    const publicHtml = publicUrls.length
        ? `<p style="color:#444;margin:16px 0 4px">${c.publicLead}</p>` +
          publicUrls
              .map((u) => `<p style="margin:2px 0"><a href="${u}" style="color:#2563eb">${escapeHtml(u)}</a></p>`)
              .join('')
        : '';
    const textParts = [
        c.hello,
        c.textIntro,
        ...messages.map((m) => (m.subject ? `${m.subject}\n${m.body}` : m.body)),
        opts.releaseUrl ? c.releaseText(opts.releaseUrl) : '',
        ...(publicUrls.length ? [c.publicText, ...publicUrls] : []),
    ].filter(Boolean);
    await send({
        to,
        subject: c.subject,
        text: textParts.join('\n\n'),
        html: shell(
            `<p style="color:#444;margin:0 0 8px">${escapeHtml(c.hello)}</p>` +
                `<h2 style="margin:0 0 8px">${c.heading}</h2>` +
                `<p style="color:#444;margin:0 0 8px">${escapeHtml(c.intro)}</p>` +
                messagesHtml +
                releaseHtml +
                publicHtml,
        ),
    });
}
