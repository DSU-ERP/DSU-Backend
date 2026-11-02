-- Company FRIDAY conversations. A member sees only their own conversations,
-- and only while they belong to the company that owns them.
CREATE TABLE company.conversations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES placement.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_conversations_user ON company.conversations(user_id,updated_at DESC,id);
CREATE TABLE company.messages(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES company.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('user','assistant')),
  content text NOT NULL CHECK(length(content)<=30000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_messages_conversation ON company.messages(conversation_id,id);
ALTER TABLE company.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE company.messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON company.conversations,company.messages FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON company.conversations TO dsu_api;
GRANT SELECT,INSERT ON company.messages TO dsu_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA company TO dsu_api;
CREATE POLICY own_conversation ON company.conversations TO dsu_api
  USING(user_id=erp.actor_id() AND company_id=company.actor_company())
  WITH CHECK(user_id=erp.actor_id() AND company_id=company.actor_company());
CREATE POLICY own_message ON company.messages TO dsu_api
  USING(user_id=erp.actor_id() AND EXISTS(SELECT 1 FROM company.conversations c WHERE c.id=conversation_id))
  WITH CHECK(user_id=erp.actor_id() AND EXISTS(SELECT 1 FROM company.conversations c WHERE c.id=conversation_id));
NOTIFY pgrst,'reload schema';
