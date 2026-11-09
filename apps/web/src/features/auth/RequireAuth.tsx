import { Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from '../../components/Spinner.tsx';
import { useMe } from './useMe.ts';

// Route guard: renders the page if logged in, otherwise sends the user to /login
// (remembering where they were going, so login can bring them back).
export function RequireAuth() {
  const { data: user, isPending, isError } = useMe();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-brand-600" />
      </div>
    );
  }
  if (isError) {
    return <div className="grid h-full place-items-center text-sm text-zinc-500">Can't reach the server. Is the API running?</div>;
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
