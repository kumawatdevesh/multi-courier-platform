import { requireCredential } from '../../config/couriers';
import { CourierError } from '../../errors/courier-error';
import type { CourierConfig, CourierContext } from '../courier.interface';
import { CourierHttpClient } from '../shared/http-client';
import { TokenCache } from '../shared/token-cache';

export const AUTH_PATH = '/api/v1/auth/getToken/';

interface UbTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  expires?: string;
  status?: string;
}

/** Username/password → bearer token. A cache-less client, so it cannot recurse into itself. */
export function createTokenCache(config: CourierConfig): TokenCache {
  const username = requireCredential(config, 'username');
  const password = requireCredential(config, 'password');
  const authClient = new CourierHttpClient(config);

  return new TokenCache(
    async () => {
      const ctx: CourierContext = {
        requestId: `auth-${config.key}-${Date.now()}`,
        audit: () => undefined,
      };

      const { data } = await authClient.request<UbTokenResponse>(
        { method: 'POST', path: AUTH_PATH, body: { username, password } },
        ctx,
      );

      if (!data?.access_token) {
        throw new CourierError('COURIER_AUTH_FAILED', {
          courierPartner: config.key,
          rawResponse: data,
        });
      }

      return { token: data.access_token, expiresInSec: data.expires_in ?? 3600 };
    },
    { courierKey: config.key },
  );
}
