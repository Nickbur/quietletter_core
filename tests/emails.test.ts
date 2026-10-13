import { beforeEach, describe, expect, it, vi } from 'vitest';

// Force the SMTP path (dev mode would only print the text part) so the composed
// message reaches the mocked transport. Nothing connects.
vi.mock('../src/env.js', () => ({
    env: { EMAIL_DEV_MODE: false, SMTP_HOST: 'smtp.test.invalid', SMTP_PORT: 587, MAIL_FROM: 'core@test.invalid' },
}));
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

import { sendFireEmail, sendWarningEmail } from '../src/shared/email.service.js';

/** The core's emails print times on the switch's clock and are written in the switch's language. */

interface Mail {
    subject: string;
    text: string;
    html: string;
}
const lastMail = (): Mail => sendMail.mock.calls.at(-1)?.[0] as Mail;
const AT = new Date('2026-08-05T06:00:00.000Z'); // 09:00 in Kyiv

beforeEach(() => sendMail.mockReset());

describe('sendWarningEmail', () => {
    it('writes in English on the switch clock by default', async () => {
        await sendWarningEmail('owner@test.invalid', {
            title: 'For my family',
            firesAt: AT,
            timeZone: 'Europe/Kyiv',
            checkinUrl: 'https://core.test',
        });
        expect(lastMail().subject).toBe('Check in to keep "For my family" from firing');
        expect(lastMail().text).toMatch(/fire on Wednesday, August 5, 2026 at 9:00\sAM \(Europe\/Kyiv\)/);
    });

    it('writes in Russian for a Russian switch', async () => {
        await sendWarningEmail('owner@test.invalid', {
            title: 'Для семьи',
            firesAt: AT,
            timeZone: 'Europe/Kyiv',
            checkinUrl: 'https://core.test',
            locale: 'ru',
        });
        expect(lastMail().subject).toBe('Отметьтесь, чтобы «Для семьи» не сработал');
        expect(lastMail().text).toMatch(/сработает среда, 5 августа 2026.*09:00 \(Europe\/Kyiv\)/);
        expect(lastMail().text).toContain('Отметьтесь в приложении Quietletter (инстанс: https://core.test).');
    });
});

describe('sendFireEmail', () => {
    it("writes the recipients' email in the switch's language, public pages included", async () => {
        await sendFireEmail('heir@test.invalid', {
            switchTitle: 'Для семьи',
            recipientName: 'Аня',
            readableMessages: [{ subject: 'Для Ани', body: 'Люблю вас.' }, { body: 'Без темы.' }],
            releaseUrl: 'https://core.test/release/abc',
            publicUrls: ['https://core.test/p/statement'],
            locale: 'ru',
        });
        const mail = lastMail();
        expect(mail.subject).toBe('Вам кое-что оставили: Для семьи');
        expect(mail.text).toMatch(/^Здравствуйте, Аня,\n\n/);
        expect(mail.text).toContain('Для Ани\nЛюблю вас.');
        expect(mail.text).toContain('\n\nБез темы.');
        expect(mail.html).toContain('Для Ани</p>');
        expect(mail.text).toContain('Публичные страницы:\n\nhttps://core.test/p/statement');
        expect(mail.html).toContain('Открыть то, что вам оставили');
    });

    it('stays in English for a switch without a language', async () => {
        await sendFireEmail('heir@test.invalid', { switchTitle: 'For my family' });
        expect(lastMail().subject).toBe('Something was left for you: For my family');
    });
});
