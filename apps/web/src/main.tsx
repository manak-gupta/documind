import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { ApiError } from './lib/api.ts';
import { RequireAuth } from './features/auth/RequireAuth.tsx';
import { LoginPage } from './features/auth/LoginPage.tsx';
import { Workspace } from './features/workspace/Workspace.tsx';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Don't retry "not logged in" or "not found": retrying can't fix them.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      // One Workspace for both URLs: the child route only changes the URL, so the Workspace
      // (and any answer it's streaming) stays mounted when a new conversation gets its id.
      { path: '/', element: <Workspace />, children: [{ path: 'c/:conversationId', element: null }] },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
