PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  telegram_user_id INTEGER PRIMARY KEY,
  username TEXT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('owner','admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  manager_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  birthday_mmdd TEXT NOT NULL,
  birth_year INTEGER,
  telegram_username TEXT,
  telegram_user_id INTEGER UNIQUE,
  invite_code TEXT NOT NULL UNIQUE,
  unit_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(unit_id) REFERENCES units(id)
);

CREATE INDEX IF NOT EXISTS idx_employees_birthday ON employees(birthday_mmdd, active);
CREATE INDEX IF NOT EXISTS idx_employees_unit ON employees(unit_id, active);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  birthday_mmdd TEXT NOT NULL,
  birth_year INTEGER,
  company TEXT,
  responsible TEXT,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clients_birthday ON clients(birthday_mmdd, active);

CREATE TABLE IF NOT EXISTS sessions (
  telegram_user_id INTEGER PRIMARY KEY,
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  birthday_employee_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  event_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(birthday_employee_id, event_date),
  FOREIGN KEY(birthday_employee_id) REFERENCES employees(id),
  FOREIGN KEY(unit_id) REFERENCES units(id)
);

CREATE TABLE IF NOT EXISTS collection_responses (
  collection_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','joined','paid','declined')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(collection_id, employee_id),
  FOREIGN KEY(collection_id) REFERENCES collections(id),
  FOREIGN KEY(employee_id) REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  person_type TEXT NOT NULL,
  person_id INTEGER NOT NULL,
  target_chat_id INTEGER NOT NULL,
  event_date TEXT NOT NULL,
  lead_days INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kind, person_type, person_id, target_chat_id, event_date, lead_days)
);

INSERT OR IGNORE INTO units(name, manager_name)
VALUES ('Основной юнит', 'Руководитель');
