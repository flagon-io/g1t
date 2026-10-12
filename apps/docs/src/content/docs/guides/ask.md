---
title: Ask g1t
description: Ask g1t about your work from the top bar of any page. It answers with your workspace's own AI provider and key, knows which page you are on, and reads the issue or pull request in front of you.
---

**Ask**, in the top bar, opens a conversation with g1t beside the page
you are on. Ask about the issue you are reading, the pull request you are
reviewing, or anything else about your work, and the answer streams in as
it is written.

Ask answers with **your workspace's own AI provider**, on your workspace's
own key: one of [your AI providers](/guides/integrations/#your-ai-providers),
and the model an owner chose for it. g1t hosts no model for Ask and bills
nothing for it; what an answer costs is on your provider's bill. Your key
stays sealed in g1t: it is used to call the provider and is never sent to
your browser.

## Set it up

An owner of the workspace sets it up once:

1. Open **Integrations → Your AI providers**, at
   `g1t.sh/<workspace>/-/integrations/models`.
2. Connect a provider if there is none yet: Anthropic, OpenAI, Gemini or
   any of the others, or your own Anthropic- or OpenAI-compatible
   endpoint.
3. Under **Ask g1t**, choose the provider and one of the models it offers,
   then **Use for Ask**. For Azure OpenAI, give the deployment's name; for
   an endpoint that does not list its models, the model's name.

Every member can then ask. Until a provider is chosen, Ask says so: owners
get a link to set it up, and members are told to ask an owner. **Turn Ask
off** on the same page stops it answering, and removing the provider it
uses does too.

Every AI provider g1t connects works with Ask: Anthropic and
Anthropic-compatible endpoints through Anthropic's Messages API, and the
rest through OpenAI's Chat Completions API.

## What it knows

Each question is sent with a short note saying that this is Ask in your
workspace and which page you are on: the repository, and the issue or pull
request number, when there is one. On an issue or a pull request, g1t also
reads its title, state and description, as you can see them, and sends
those along, so you can ask "what is left to do here?" without pasting
anything.

That is all it is given. Ask cannot change anything in g1t or read
anything beyond that page; if you ask it to, it says so. Its answers come
from a model and can be wrong.

## Conversations

Ask keeps one conversation per workspace, in your browser tab: it stays as
you move between pages and when you reload, and is gone when you close the
tab. **New conversation** starts over, and **Stop** ends an answer while it
is being written; what had come so far stays. Each answer shows the
provider and model that wrote it.

## Limits

- 20 questions a minute for each person.
- A question can be up to 16,000 characters, and a conversation up to
  64,000 characters; past that, start a new one. Only the conversation's
  latest 40 messages are sent.
- An answer is at most 4,096 tokens long, and says when it was cut off.
