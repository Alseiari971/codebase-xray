import { login } from '@/auth/login';

export const handleLogin = async (body: { email: string; password: string }) => {
  const user = await login(body.email, body.password);
  return user ? 200 : 401;
};
