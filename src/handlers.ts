import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';
import { ValidationError } from './shared/errors.js';
import { renderNotFoundPage, renderPublicPage, renderReleasePage, type PageLinks } from './shared/html.js';
import { vendorScript } from './shared/vendor.js';
import { payloadAckDTO, switchDTO } from './serializers.js';
import { createSwitchSchema, parse, putPayloadSchema, regionalSchema } from './schemas.js';
import {
    applySwitchImport,
    checkinSwitch,
    deleteSwitch,
    disarmSwitch,
    exportSwitches,
    fillSwitchRegional,
    getPublicPage,
    getReleaseBundle,
    getSwitch,
    listSwitches,
    planSwitchImport,
    putPayload,
    upsertSwitch,
} from './service.js';
import { exportFileName } from './transfer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Footer links on the public HTML pages. */
const PAGE_LINKS: PageLinks = { docs: env.DOCS_URL, privacy: env.PRIVACY_URL, terms: env.TERMS_URL };

function idParam(request: FastifyRequest<{ Params: { id: string } }>): string {
    const id = request.params.id;
    if (!UUID_RE.test(id)) throw new ValidationError('invalid_id', 'switch id must be a UUID');
    return id;
}

// --- Owner API (bearer-gated) ------------------------------------------------

/** GET /v1/switches */
export async function listSwitchesHandler(_request: FastifyRequest, reply: FastifyReply) {
    const rows = await listSwitches();
    return reply.send(rows.map(switchDTO));
}

/** GET /v1/switches/:id */
export async function getSwitchHandler(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const row = await getSwitch(idParam(request));
    if (!row) return reply.code(404).send({ code: 'switch_not_found', message: 'switch not found' });
    return reply.send(switchDTO(row));
}

/**
 * PUT /v1/switches/:id — upsert config by client id. Self-host is unlimited: no
 * Pro gate, no free-tier switch cap, and `public_page` actions are ACCEPTED (the
 * whole point of the self-host build).
 */
export async function putSwitchHandler(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const id = idParam(request);
    const input = parse(createSwitchSchema, request.body);
    const { row, created } = await upsertSwitch(id, input);
    return reply.code(created ? 201 : 200).send(switchDTO(row));
}

/** POST /v1/switches/:id/checkin — proof of life. */
export async function checkinHandler(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const row = await checkinSwitch(idParam(request));
    return reply.send(switchDTO(row));
}

/** PUT /v1/switches/:id/regional — fill in the zone / language a legacy switch is missing. */
export async function putRegionalHandler(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const input = parse(regionalSchema, request.body);
    const row = await fillSwitchRegional(idParam(request), input);
    return reply.send(switchDTO(row));
}

/** POST /v1/switches/:id/disarm — turn the switch off (reversible via check-in). */
export async function disarmHandler(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const row = await disarmSwitch(idParam(request));
    return reply.send(switchDTO(row));
}

/** DELETE /v1/switches/:id */
export async function deleteSwitchHandler(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    await deleteSwitch(idParam(request));
    return reply.code(204).send();
}

/**
 * GET /v1/switches/export — every live switch, payloads included, as one portable
 * file (see transfer.ts). The same file imports into the hosted service.
 */
export async function exportSwitchesHandler(_request: FastifyRequest, reply: FastifyReply) {
    const file = await exportSwitches();
    return reply
        .header('content-disposition', `attachment; filename="${exportFileName(new Date(file.exportedAt))}"`)
        .send(file);
}

/**
 * POST /v1/switches/import — recreate the switches of an export file (from the hosted
 * service or another instance). Unlimited and `public_page`-capable like a regular save.
 */
export async function importSwitchesHandler(request: FastifyRequest, reply: FastifyReply) {
    const plan = await planSwitchImport(request.body);
    const report = await applySwitchImport(plan);
    return reply.send(report);
}

/** PUT /v1/switches/:id/actions/:actionId/payload — upload the encrypted (or readable) payload. */
export async function putPayloadHandler(
    request: FastifyRequest<{ Params: { id: string; actionId: string } }>,
    reply: FastifyReply,
) {
    const { id, actionId } = request.params;
    if (!UUID_RE.test(id)) throw new ValidationError('invalid_id', 'switch id must be a UUID');
    if (!UUID_RE.test(actionId)) throw new ValidationError('invalid_id', 'action id must be a UUID');
    const input = parse(putPayloadSchema, request.body);
    const row = await putPayload(id, actionId, input);
    return reply.send(payloadAckDTO(row));
}

// --- Public surfaces (no auth) -----------------------------------------------

/**
 * GET /v1/release/:token — PUBLIC (no auth). Returns the content-blind JSON bundle
 * a recipient decrypts in the browser. 404 for an unknown/expired token or a
 * switch that has not fired (no oracle about which case).
 */
export async function releaseHandler(request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) {
    const token = request.params.token;
    if (typeof token !== 'string' || token.length < 16 || token.length > 64) {
        return reply.code(404).send({ code: 'not_found', message: 'invalid release link' });
    }
    const bundle = await getReleaseBundle(token);
    if (!bundle) return reply.code(404).send({ code: 'not_found', message: 'this release link is not valid' });
    return reply.send({
        switchTitle: bundle.switchTitle,
        firedAt: bundle.firedAt ? bundle.firedAt.toISOString() : null,
        recipientName: bundle.recipientName,
        actions: bundle.actions,
    });
}

/**
 * GET /release/:token — PUBLIC HTML page. A self-contained recipient page that
 * fetches the JSON bundle and renders it (readable content immediately; ZK items
 * via an in-browser reference decryptor). This is where the fire email links.
 */
export async function releasePageHandler(request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) {
    const token = request.params.token;
    if (typeof token !== 'string' || token.length < 16 || token.length > 64) {
        return reply
            .code(404)
            .type('text/html; charset=utf-8')
            .send(renderNotFoundPage('Invalid release link.', PAGE_LINKS));
    }
    return reply.code(200).type('text/html; charset=utf-8').send(renderReleasePage(token, PAGE_LINKS));
}

/**
 * GET /vendor/:file — PUBLIC. The libsodium browser build the release page decrypts
 * with, served from this instance rather than a CDN (see shared/vendor.ts).
 */
export async function vendorHandler(request: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) {
    const script = vendorScript(request.params.file);
    if (!script) return reply.code(404).send({ code: 'not_found', message: 'not found' });
    return reply
        .type('text/javascript; charset=utf-8')
        .header('cache-control', 'public, max-age=86400')
        .send(await script);
}

/**
 * GET /p/:slug — PUBLIC, indexable HTML. Serves a `public_page` action's content
 * in the clear once its switch has fired. This is the self-host-only "leak" page
 * the cloud refuses to host (§11.4 / §16.4).
 */
export async function publicPageHandler(request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) {
    const slug = request.params.slug;
    const page = slug ? await getPublicPage(slug) : null;
    if (!page) {
        return reply
            .code(404)
            .type('text/html; charset=utf-8')
            .send(renderNotFoundPage('No public page is published at this address.', PAGE_LINKS));
    }
    return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(
            renderPublicPage({ title: page.title, content: page.content, publishedAt: page.publishedAt }, PAGE_LINKS),
        );
}
