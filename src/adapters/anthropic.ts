import { PassThrough } from 'node:stream';
import type { ProviderAdapter } from './types';

export const anthropicAdapter: ProviderAdapter = {
  path: '/v1/messages',
  translateRequest: (body) => body,
  translateResponse: (body) => body,
  createStreamTranslator: () => new PassThrough(),
};
