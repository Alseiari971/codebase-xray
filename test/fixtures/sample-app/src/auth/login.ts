import { readFileSync } from 'node:fs';
import type { User } from '@/db/user-repository';
import { UserRepository } from '../db/user-repository';
import { hashPassword } from '@/auth/hash';
import { missing } from './does-not-exist';

const pepper = readFileSync('pepper.txt', 'utf8');

export async function login(email: string, password: string): Promise<User | undefined> {
  const repo = new UserRepository();
  const user = repo.findByEmail(email);
  if (user && hashPassword(password + pepper) === user.passwordHash) return user;
  return undefined;
}

export { missing };
