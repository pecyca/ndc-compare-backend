import sqlite3

db_path = "merged_ndc_all_records.sqlite"
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

create_table_sql = """
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalizedNDC TEXT,
  gpiCode TEXT,
  scope TEXT NOT NULL CHECK(scope IN ('ndc', 'gpi')),
  comment TEXT NOT NULL,
  author TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

cursor.execute(create_table_sql)
conn.commit()

cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='comments';")
if cursor.fetchone():
    print("✅ 'comments' table successfully created.")
else:
    print("❌ Failed to create 'comments' table.")

conn.close()
