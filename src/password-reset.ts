import { hashPassword, MIN_PASSWORD_LENGTH, USERNAME } from "./auth";
import type { Db } from "./db/database";
import { getUserByUsername, updatePassword } from "./db/queries";

export class ResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetError";
  }
}

export async function resetPassword(db: Db, username: string, password: string): Promise<void> {
  if (!USERNAME.test(username)) throw new ResetError(`"${username}" is not a valid username.`);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ResetError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const user = getUserByUsername(db, username);
  if (!user) throw new ResetError(`No user named "${username}" in this database.`);
  updatePassword(db, user.id, await hashPassword(password));
}
