-- 003 T040: a hand-over step adds its note to the chat as an automatic note (002 allowed member notes only).
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_note_origin_check";
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_note_origin_check" CHECK ("kind" <> 'NOTE' OR "origin" IN ('MEMBER', 'AUTOMATIC'));
