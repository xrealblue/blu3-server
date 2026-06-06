-- Add default values for created_at and updated_at columns
-- Prevents account_not_linked error when better-auth creates users without explicit timestamps

ALTER TABLE "user" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "user" ALTER COLUMN "updated_at" SET DEFAULT now();

ALTER TABLE "session" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "session" ALTER COLUMN "updated_at" SET DEFAULT now();

ALTER TABLE "account" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();
