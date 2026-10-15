export interface User {
  email: string;
  passwordHash: string;
}

export class UserRepository {
  findByEmail(email: string): User | undefined {
    return this.query(`SELECT * FROM users WHERE email = '${email}'`)[0];
  }

  private query(sql: string): User[] {
    return sql ? [] : [];
  }

  static create = () => new UserRepository();
}
