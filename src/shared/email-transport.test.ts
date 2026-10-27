import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const h = vi.hoisted(() => ({
    env: {
        EMAIL_DEV_MODE: false,
        SMTP_HOST: undefined as string | undefined,
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_USER: undefined as string | undefined,
        SMTP_PASS: undefined as string | undefined,
        MAIL_FROM: 'Quietletter <no-reply@core.test>',
    },
    sendMail: vi.fn(async (..._args: unknown[]) => ({})),
    createTransport: vi.fn(),
}));
vi.mock('../env.js', () => ({ env: h.env }));
vi.mock('nodemailer', () => ({ default: { createTransport: h.createTransport } }));

/**
 * Mail delivery: without SMTP (or with EMAIL_DEV_MODE) a self-hosted instance prints every email
 * to the console, so it warns and fires end to end out of the box; with SMTP configured it sends
 * through one reused transport, authenticating only when credentials are set. The English fire
 * email carries the release link and public pages for encrypted / published items.
 */

type Mailer = typeof import('./email.service.js');

/** A fresh email module: its transport is created lazily once per module instance. */
async function mailer(env: Partial<typeof h.env> = {}): Promise<Mailer> {
    Object.assign(h.env, {
        EMAIL_DEV_MODE: false,
        SMTP_HOST: undefined,
        SMTP_SECURE: false,
        SMTP_USER: undefined,
        SMTP_PASS: undefined,
        ...env,
    });
    vi.resetModules();
    return import('./email.service.js');
}

let log: MockInstance<typeof console.log>;

beforeEach(() => {
    h.sendMail.mockReset().mockResolvedValue({});
    h.createTransport.mockReset().mockReturnValue({ sendMail: h.sendMail });
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

const warning = {
    title: 'For my family',
    firesAt: new Date('2026-08-05T06:00:00.000Z'),
    timeZone: null,
    checkinUrl: 'https://core.test',
};

describe('console delivery', () => {
    it('prints the mail instead of sending when no SMTP host is configured', async () => {
        const { sendWarningEmail } = await mailer();
        await sendWarningEmail('owner@core.test', warning);
        expect(h.createTransport).not.toHaveBeenCalled();
        const printed = String(log.mock.calls[0]?.[0]);
        expect(printed).toContain('[email:dev] → owner@core.test');
        expect(printed).toContain('subject: Check in to keep "For my family" from firing');
        expect(printed).toContain('it will fire on Wednesday, August 5, 2026 at 6:00');
        expect(printed).toContain('(UTC)');
    });

    it('prints the mail when EMAIL_DEV_MODE is on, even with SMTP configured', async () => {
        const { sendFireEmail } = await mailer({ EMAIL_DEV_MODE: true, SMTP_HOST: 'smtp.core.test' });
        await sendFireEmail('heir@core.test', { switchTitle: 'For my family' });
        expect(h.createTransport).not.toHaveBeenCalled();
        expect(h.sendMail).not.toHaveBeenCalled();
        expect(String(log.mock.calls[0]?.[0])).toContain('subject: Something was left for you: For my family');
    });
});

describe('SMTP delivery', () => {
    it('sends through one reused transport, without auth when no user is set', async () => {
        const { sendWarningEmail } = await mailer({ SMTP_HOST: 'smtp.core.test', SMTP_PORT: 587 });
        await sendWarningEmail('owner@core.test', warning);
        await sendWarningEmail('owner@core.test', warning);
        expect(h.createTransport).toHaveBeenCalledOnce();
        expect(h.createTransport).toHaveBeenCalledWith({
            host: 'smtp.core.test',
            port: 587,
            secure: false,
            auth: undefined,
        });
        expect(h.sendMail).toHaveBeenCalledTimes(2);
        expect(h.sendMail.mock.calls[0]?.[0]).toMatchObject({
            from: 'Quietletter <no-reply@core.test>',
            to: 'owner@core.test',
            subject: 'Check in to keep "For my family" from firing',
        });
        expect(log).not.toHaveBeenCalled();
    });

    it('authenticates with the configured credentials over a secure connection', async () => {
        const { sendWarningEmail } = await mailer({
            SMTP_HOST: 'smtp.core.test',
            SMTP_PORT: 465,
            SMTP_SECURE: true,
            SMTP_USER: 'mailer',
            SMTP_PASS: 's3cret',
        });
        await sendWarningEmail('owner@core.test', warning);
        expect(h.createTransport).toHaveBeenCalledWith({
            host: 'smtp.core.test',
            port: 465,
            secure: true,
            auth: { user: 'mailer', pass: 's3cret' },
        });
    });

    it('surfaces a failed send to the caller (the sweep retries a fire email)', async () => {
        const { sendFireEmail } = await mailer({ SMTP_HOST: 'smtp.core.test' });
        h.sendMail.mockRejectedValueOnce(new Error('550 mailbox unavailable'));
        await expect(sendFireEmail('heir@core.test', { switchTitle: 'x' })).rejects.toThrow('550 mailbox unavailable');
    });
});

describe('fire email content', () => {
    interface Mail {
        subject: string;
        text: string;
        html: string;
    }
    const lastMail = (): Mail => h.sendMail.mock.calls.at(-1)?.[0] as Mail;

    it('greets by name and links the release page and the public pages in English', async () => {
        const { sendFireEmail } = await mailer({ SMTP_HOST: 'smtp.core.test' });
        await sendFireEmail('heir@core.test', {
            switchTitle: 'For <my> family',
            recipientName: 'Ann & Bob',
            readableMessages: [
                { subject: '  ', body: 'No subject <here>.' },
                { subject: 'Blank', body: '   ' },
            ],
            releaseUrl: 'https://core.test/release/tok',
            publicUrls: ['https://core.test/p/statement', ''],
        });
        const mail = lastMail();
        expect(mail.subject).toBe('Something was left for you: For <my> family');
        expect(mail.text.split('\n\n')).toEqual([
            'Hello Ann & Bob,',
            'Something was left for you through Quietletter ("For <my> family").',
            'No subject <here>.',
            "Open the secure items here: https://core.test/release/tok (you'll need the passphrase the sender shared with you).",
            'Public pages:',
            'https://core.test/p/statement',
        ]);
        expect(mail.html).toContain('Hello Ann &amp; Bob,');
        expect(mail.html).toContain('For &lt;my&gt; family');
        expect(mail.html).toContain('No subject &lt;here&gt;.');
        expect(mail.html).not.toContain('Blank');
        expect(mail.html).toContain('<a href="https://core.test/release/tok"');
        expect(mail.html).toContain('Open what was left for you');
        expect(mail.html).toContain('<a href="https://core.test/p/statement" style="color:#2563eb">');
    });

    it('greets without a name, and leaves out the release and public-page blocks when there are none', async () => {
        const { sendFireEmail } = await mailer({ SMTP_HOST: 'smtp.core.test' });
        await sendFireEmail('heir@core.test', { switchTitle: 'T', recipientName: null, locale: 'ru' });
        expect(lastMail().text).toMatch(/^Здравствуйте,\n\n/);
        await sendFireEmail('heir@core.test', { switchTitle: 'T', releaseUrl: null, publicUrls: [] });
        const mail = lastMail();
        expect(mail.text).toBe('Hello,\n\nSomething was left for you through Quietletter ("T").');
        expect(mail.html).not.toContain('/release/');
        expect(mail.html).not.toContain('Public pages');
    });
});
