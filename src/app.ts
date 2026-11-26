import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from './sqlite.js';
import { ZodError } from 'zod';
import {
  CreateSourceInput,
  DocumentListQuery,
  SearchQuery,
  SuggestionQuery,
  UpdateSourceIgnoreInput,
} from './contracts.js';
import { addSource, scanSource, updateSourceIgnore } from './ingest.js';
import { parseIgnore } from './ignore.js';
import { acceptSuggestion, rejectSuggestion, revokeSuggestion } from './organize.js';
import {
  getDocument,
  listDocuments,
  listSuggestions,
  searchChunks,
} from './queries.js';

export interface AppOptions {
  onSourceChanged?: () => void | Promise<void>;
}

export function buildApp(db: DatabaseSync, options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: 'VALIDATION',
        message: '请求参数不合法',
        details: error.issues,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'SOURCE_NOT_FOUND' ? 404 : 500;
    return reply.status(status).send({ code: message, message });
  });

  app.get('/v1/system/health', async () => ({
    status: 'ok' as const,
    version: '0.1.0',
    time: Date.now(),
  }));

  app.post('/v1/ingest/sources', async (request, reply) => {
    const input = CreateSourceInput.parse(request.body);
    const source = addSource(db, input.path, input.privacy);
    return reply.status(201).send({
      id: source.id,
      kind: source.kind,
      uri: source.uri,
      privacy: source.privacy,
      created_at: source.created_at,
    });
  });

  app.post('/v1/ingest/sources/:id/scan', async (request) => {
    const { id } = request.params as { id: string };
    return scanSource(db, id);
  });

  app.patch('/v1/ingest/sources/:id/ignore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { ignore } = UpdateSourceIgnoreInput.parse(request.body);
    const source = updateSourceIgnore(db, id, ignore);
    if (!source) {
      return reply.status(404).send({ code: 'SOURCE_NOT_FOUND', message: '来源不存在' });
    }
    await options.onSourceChanged?.();
    return { id, ignore: parseIgnore(source.ignore_json) };
  });

  app.get('/v1/kb/documents', async (request) => {
    const { limit, offset, include_duplicates } = DocumentListQuery.parse(request.query);
    const items = listDocuments(db, limit, offset, include_duplicates === 1);
    return { items, limit, offset };
  });

  app.get('/v1/kb/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = getDocument(db, id);
    if (!document) {
      return reply.status(404).send({ code: 'DOCUMENT_NOT_FOUND', message: '文档不存在' });
    }
    return document;
  });

  app.get('/v1/search', async (request) => {
    const { q, limit, include_duplicates } = SearchQuery.parse(request.query);
    return {
      query: q,
      items: searchChunks(db, q, limit, include_duplicates === 1),
    };
  });

  app.get('/v1/organize/suggestions', async (request) => {
    const { status, limit } = SuggestionQuery.parse(request.query);
    return { status, items: listSuggestions(db, status, limit) };
  });

  app.post('/v1/organize/suggestions/:id/accept', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = acceptSuggestion(db, id);
    if (result === 'not_found') {
      return reply.status(404).send({ code: 'SUGGESTION_NOT_FOUND', message: '建议不存在或已处理' });
    }
    if (result === 'invalid') {
      return reply.status(422).send({
        code: 'SUGGESTION_INVALID',
        message: '建议缺少可用的保留对象，或会造成循环引用',
      });
    }
    return { id, status: 'accepted' };
  });

  app.post('/v1/organize/suggestions/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!rejectSuggestion(db, id)) {
      return reply.status(404).send({ code: 'SUGGESTION_NOT_FOUND', message: '建议不存在或已处理' });
    }
    return { id, status: 'rejected' };
  });

  app.post('/v1/organize/suggestions/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = revokeSuggestion(db, id);
    if (result === 'not_found') {
      return reply.status(404).send({ code: 'SUGGESTION_NOT_FOUND', message: '建议不存在或未接受' });
    }
    if (result === 'expired') {
      return reply.status(409).send({ code: 'REVOKE_EXPIRED', message: '已超过 30 天撤销窗口' });
    }
    if (result === 'conflict') {
      return reply.status(409).send({
        code: 'REVOKE_CONFLICT',
        message: '该文档的重复关系已被后续操作改变，未回滚',
      });
    }
    return { id, status: 'revoked' };
  });

  return app;
}
