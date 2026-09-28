ALTER TABLE memberships ADD COLUMN can_publish INTEGER NOT NULL DEFAULT 0 CHECK (can_publish IN (0, 1));

UPDATE memberships SET can_publish = 1;
