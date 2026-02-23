-- Create user and database for Tally & Trace
CREATE USER "user" WITH PASSWORD 'password';
CREATE DATABASE accounting_db OWNER "user";
GRANT ALL PRIVILEGES ON DATABASE accounting_db TO "user";

-- Connect to the new database
\c accounting_db

-- Grant schema privileges
GRANT ALL ON SCHEMA public TO "user";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "user";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "user";
