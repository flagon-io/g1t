CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL;
