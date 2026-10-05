# n8n-nodes-manypi

This is an n8n community node. It lets you use [ManyPI](https://manypi.com) in your n8n workflows.

ManyPI is an AI sales platform for lead generation and cold email outreach. Describe your ideal customer and its agent finds matching companies and contacts, verifies their email addresses, and sends your sequences from your own inboxes, with replies and a do-not-contact list tracked for you.

With this node you can start lead searches on a schedule, send new leads to your CRM, verify addresses, enroll leads in campaigns, and route replies to the right person.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Trigger](#trigger)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Example workflows](#example-workflows)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. The package name is `n8n-nodes-manypi`.

## Operations

The **ManyPI** node covers the whole ManyPI API, from finding leads to handling replies. It can also be used as a tool by the n8n AI Agent.

| Resource | Operations |
| --- | --- |
| Lead | Create or Update, Delete, Delete Many, Export, Get, Get Capacity, Get Many, Import, Update, Update Many |
| Lead Search | Create or Update, Delete, Get Many, Start |
| Lead Column | Create, Get Many |
| Email Verification | Get, Get Many, Verify |
| Campaign | Create, Delete, Enroll Leads, Get, Get Many, Get Stats, Remove Leads, Update |
| Sequence | Create, Get Many |
| Email | Draft With AI, Send |
| Inbox | Get Many |
| Reply | Get Insights, Get Many |
| Suppression | Add, Get Many, Remove |
| Agent Run | Cancel, Create, Delete, Get, Get Many, Reply |
| Skill | Create, Get Many |
| Scraper | Get Many, Run |
| Scraper Run | Get, Get Data, Get Many |
| Endpoint | Create, Delete, Get, Get Many, Get Result, Invoke |
| Account | Get |

## Trigger

The **ManyPI Trigger** node polls ManyPI and starts a workflow when:

| Event | Fires when |
| --- | --- |
| New Lead | A lead is saved, optionally filtered by status, search text or lead search. |
| New Reply | A campaign gets a human reply, auto-reply or bounce, optionally filtered by campaign and sentiment. |
| Email Verification Reached Status | An email verification job finishes. |
| Agent Run Reached Status | An agent run reaches a chosen status. Add Paused to hear when the agent is waiting for an answer. |
| New Campaign | A campaign is created. |
| Scraper Run Reached Status | A scraper run reaches a chosen status. The default is Completed, so the data is ready. |

When you activate a workflow, the trigger records what already exists and fires only for records that appear or change after that. The status events fire once for each status a run reaches. So with Paused and Completed both chosen, a run that stops to ask a question and later finishes fires twice. Use **Fetch Test Event** to see the newest matching record while you build the workflow.

The scraper run and agent run events look at the 100 most recent runs on each poll.

## Credentials

You need a ManyPI account. Connect it in one of two ways, chosen with **Authentication** on the node:

- **OAuth2:** sign in to ManyPI from n8n. There is nothing to copy. Needs n8n 1.119 or later.
- **API Key:** paste a key. Use this to control exactly which permissions n8n gets. It is also the only option for Endpoint > Invoke and Get Result.

### OAuth2

1. On the node, set **Authentication** to **OAuth2**.
2. Create a **ManyPI OAuth2 API** credential and click **Connect my account**.
3. Sign in to ManyPI and approve the connection.

n8n registers itself with ManyPI the first time you connect, so there is no OAuth app to create and no client ID to paste. The connection renews itself. If ManyPI later refuses it, the error asks you to reconnect.

An OAuth2 connection can do anything your ManyPI account can. Published endpoints (`app.manypi.com/v1/e/…`) only accept API keys, so Endpoint > Invoke and Get Result say so when the node uses OAuth2.

### API key

1. Sign in to [app.manypi.com](https://app.manypi.com) and open **API Access** in the profile menu.
2. Create a key. Every permission is ticked by default. Untick any the workflow will never need:

   | Permission | Needed for |
   | --- | --- |
   | Read | Every Get and Get Many operation, and the trigger |
   | Write | Creating, updating and deleting scrapers, endpoints, leads, campaigns, sequences and skills |
   | Run Scrapers | Scraper > Run |
   | Run Agents | Agent Run > Create, Reply and Cancel, and Lead Search > Start |
   | Invoke Endpoints | Endpoint > Invoke and Get Result |
   | Verify Email Addresses | Email Verification > Verify |
   | Send Outreach | Email > Send and Campaign > Enroll Leads |

3. In n8n, create a **ManyPI API** credential and paste the key, which starts with `mpi_`.

n8n tests the key when you save the credential. ManyPI answers a key that lacks a permission the same way as a key that does not exist. So when an operation reports that the key was not accepted, the error names the permission that operation needs.

## Compatibility

- Built with the n8n node CLI, `@n8n/node-cli`, using n8n nodes API version 1.
- Tested with n8n 2.8.4.
- OAuth2 needs n8n 1.119 or later, the first release with OAuth dynamic client registration. API keys work on any version that supports community nodes.
- No runtime dependencies. Works on n8n Cloud and self-hosted n8n.

## Usage

**Background work.** Agent runs, lead searches and email verifications run for minutes, not seconds, so these operations return at once with an ID. Continue in a workflow that starts from the ManyPI Trigger. For example, use Agent Run Reached Status set to Completed.

**Batch limits.** ManyPI caps how much one call can carry. Import takes 100 leads, Update Many and Delete Many take 500, Enroll Leads takes 1,000, and Verify and Suppression > Add take 5,000. The node stops with a message before sending an oversized batch. Put a **Loop Over Items** node in front to split larger lists.

**Updating leads safely.** In Lead > Update, an empty value is ignored rather than written. That way an expression that resolves to nothing cannot wipe a field. To blank a field on purpose, list its key under **Fields to Clear**. ManyPI saves one field per request. If one field is refused, the fields before it are already saved.

**Custom columns.** Custom values are stored under each column's key. A label such as "Tech Stack" is turned into its key, `tech_stack`, before it is sent. A column must exist before a lead can hold a value in it. Declare it with Lead Column > Create, or turn on **Declare Missing Columns**.

**Lead searches.** Lead Search > Start does not save its criteria unless you turn on **Save as Reusable Search**, so a scheduled workflow doesn't pile up saved searches. When you pick a saved search, criteria you set replace only the matching parts of it. If the description names leads the workspace already has, ManyPI returns those leads with `started: false` and runs nothing. Turn on **Search Even If Leads Exist** to search anyway.

**Deletes are checked.** Delete operations first confirm the record exists, so a mistyped ID fails instead of reporting a deletion. Agent Run > Cancel reports `cancelled: false` for a run that had already finished. Suppression > Remove reports `removed: false` for an address that was not on the list.

**Reply sentiment.** Sentiment filters need a plan with reply intelligence. On other plans, ManyPI ignores the filter, so the node stops with a message instead of passing every reply through as if it matched.

**Merge variables in emails.** Subjects and bodies can use ManyPI merge variables such as `{{first_name}}` and `{{company}}`. ManyPI fills them in per lead. Type them in a fixed (non-expression) field. In an expression field, n8n would try to evaluate the double braces itself.

**Archive rather than delete.** Archived leads and campaigns are hidden everywhere but can be restored. Deleting is permanent.

**Waiting for scraper results.** Scraper > Run waits for the run to finish by default and returns the extracted data under `data`. Set **Max Wait** to how long the step may take. A run that is still going comes back with `waitTimedOut: true` and keeps running in ManyPI. Collect it later with Scraper Run > Get Data, or start a separate workflow from the trigger. To start a run and move on at once, turn off **Wait for Completion**.

**Lists of scraped results.** When a scraper returns a list, it arrives as one item with the list under `data`. Add a **Split Out** node on `data` to get one item per entry.

## Example workflows

- **Find new leads every week.** Schedule Trigger, then ManyPI (Lead Search > Start, with a saved search). The leads it finds arrive through the ManyPI Trigger's New Lead event.
- **Send new leads to your CRM.** ManyPI Trigger (New Lead), then HubSpot (Create or Update Contact) mapping `email`, `full_name` and `company`.
- **Verify, then enroll, new leads.** ManyPI Trigger (New Lead), then ManyPI (Email Verification > Verify with the lead ID). Then a second workflow: ManyPI Trigger (Email Verification Reached Status), then ManyPI (Campaign > Enroll Leads).
- **Route positive replies to sales.** ManyPI Trigger (New Reply, Type Human Reply, Sentiment Positive), then Slack (Send Message) to the sales channel, or HubSpot (Create or Update Contact) mapping `from_email` and `from_name`.
- **Answer the agent from Slack.** ManyPI Trigger (Agent Run Reached Status, Paused), then Slack (Send and Wait for Response) with `result_summary` as the question, then ManyPI (Agent Run > Reply) with the answer.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [ManyPI API reference](https://docs.manypi.com/api-reference/introduction)
- [ManyPI website](https://manypi.com)

## Support

- Email: [hello@manypi.com](mailto:hello@manypi.com)
- Bugs and feature requests: [open an issue on GitHub](https://github.com/manypicom/n8n-nodes-manypi/issues)

When you report a bug, please include your n8n version, the `n8n-nodes-manypi` version, the resource and operation you used, and the error message.

## Development

```bash
git clone https://github.com/manypicom/n8n-nodes-manypi.git
cd n8n-nodes-manypi
npm install
npm run lint
npm test        # builds, then runs the behaviour tests without network access
npm run dev     # starts n8n with the node loaded, rebuilding on changes
```

`npm run dev` downloads the latest n8n, which needs Node.js 24 or later. On an older Node.js the n8n server fails to install and exits.

## Version history

See [CHANGELOG.md](CHANGELOG.md) for every release.

The first release contains the ManyPI node with 16 resources and 57 operations, the ManyPI Trigger with 6 events, and API key authentication.

## License

[MIT](LICENSE.md)
