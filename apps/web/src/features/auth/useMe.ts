import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api.ts';

// The logged-in user, or null. The server is the source of truth: the session cookie is
// httpOnly, so JavaScript can't read it, and we ask /me instead.
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api.me()).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
  });
}
