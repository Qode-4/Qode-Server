export type AuthUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
};

export type AuthUserWithPassword = AuthUser & {
  passwordHash: string;
  tokenVersion: number;
};

export type SignupInput = {
  email: string;
  password: string;
  name: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type SignupResult = {
  token: string;
  user: AuthUser;
};

export type LoginResult = SignupResult;

export type RefreshResult = SignupResult;

export type AuthTokenBundle = {
  token: string;
  user: AuthUser;
  refreshToken: string;
};

export type MeResult = {
  id: string;
  token: string;
  email: string;
  name: string;
  avatarUrl: string | null;
};
