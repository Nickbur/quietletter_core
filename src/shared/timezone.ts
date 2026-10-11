/**
 * Time zone helpers. A switch carries the IANA zone of the device that last saved
 * it (`Europe/Kyiv`): its cadence steps on that calendar (logic.ts) and the warning
 * email prints the fire time on that clock. Mirrors the hosted API's
 * `shared/timezone.ts` (minus the account-zone parts — the core has no accounts).
 */

/** True when `zone` is an IANA time zone name the runtime can compute in (bare offsets are rejected). */
export function isValidTimeZone(zone: string | null | undefined): zone is string {
    if (!zone || !/^[A-Za-z]/.test(zone)) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/**
 * An instant on a zone's wall clock for an email, naming the zone, e.g.
 * "Wednesday, August 5, 2026 at 9:00 AM (Europe/Kyiv)" or, in Russian,
 * "среда, 5 августа 2026 г. в 09:00 (Europe/Kyiv)". A missing or unknown zone (a
 * switch saved before switches carried one) prints in UTC.
 */
export function formatZonedTime(at: Date, timeZone: string | null | undefined, lang: 'en' | 'ru' = 'en'): string {
    const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
    const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
    const when = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone: zone }).format(at);
    return `${when} (${zone})`;
}

/** Russian email copy for a `ru*` switch language; every other language (or none) gets English. */
export function isRussian(locale: string | null | undefined): boolean {
    return (locale ?? '').toLowerCase().startsWith('ru');
}
