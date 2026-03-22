# Hacker News API

> Source: https://github.com/HackerNews/API
> Base URL: `https://hacker-news.firebaseio.com/v0/`

No current rate limit. Built on Firebase — client libraries recommended for efficient networking and real-time change events.

Clients should silently ignore unexpected additional fields. The v0 API reflects HN's internal data structures — operations like counting comments require traversing the item tree manually.

---

## Endpoints

| Resource | URL |
|:---------|:----|
| Single item | `/v0/item/<id>.json` |
| Single user | `/v0/user/<id>.json` |
| Max item ID | `/v0/maxitem.json` |
| Top stories | `/v0/topstories.json` |
| New stories | `/v0/newstories.json` |
| Best stories | `/v0/beststories.json` |
| Ask HN | `/v0/askstories.json` |
| Show HN | `/v0/showstories.json` |
| Jobs | `/v0/jobstories.json` |
| Recent changes | `/v0/updates.json` |

---

## Items

Stories, comments, jobs, Ask HNs, and polls are all "items."

**Endpoint:** `/v0/item/<id>.json`

### Fields

| Field | Description |
|:------|:------------|
| `id` | Unique integer identifier (required) |
| `type` | `job`, `story`, `comment`, `poll`, or `pollopt` |
| `by` | Author's username |
| `time` | Creation time (Unix timestamp) |
| `text` | HTML content (comments, stories, polls) |
| `deleted` | `true` if deleted |
| `dead` | `true` if dead |
| `parent` | Parent comment or story ID |
| `poll` | Associated poll ID (for pollopts) |
| `kids` | Child comment IDs in ranked order |
| `url` | Story URL |
| `score` | Story score or pollopt votes |
| `title` | HTML title (stories, polls, jobs) |
| `parts` | Related pollopt IDs in display order |
| `descendants` | Total comment count (stories/polls) |

### Examples

**Story:**

```
GET https://hacker-news.firebaseio.com/v0/item/8863.json?print=pretty
```

```json
{
  "by": "dhouston",
  "descendants": 71,
  "id": 8863,
  "kids": [8952, 9224, 8917, 8884, 8887, 8943, 8869, 8958, 9005, 9671, 8940, 9067, 8908, 9055, 8865, 8881, 8872, 8873, 8955, 10403, 8903, 8928, 9125, 8998, 8901, 8902, 8907, 8894, 8878, 8870, 8980, 8934, 8876],
  "score": 111,
  "time": 1175714200,
  "title": "My YC app: Dropbox - Throw away your USB drive",
  "type": "story",
  "url": "http://www.getdropbox.com/u/2/screencast.html"
}
```

**Comment:**

```
GET https://hacker-news.firebaseio.com/v0/item/2921983.json?print=pretty
```

```json
{
  "by": "norvig",
  "id": 2921983,
  "kids": [2922097, 2922429, 2924562, 2922709, 2922573, 2922140, 2922141],
  "parent": 2921506,
  "text": "Aw shucks, guys ... you make me blush with your compliments.<p>Tell you what, Ill make a deal: I'll keep writing if you keep reading. K?",
  "time": 1314211127,
  "type": "comment"
}
```

**Ask HN:**

```
GET https://hacker-news.firebaseio.com/v0/item/121003.json?print=pretty
```

```json
{
  "by": "tel",
  "descendants": 16,
  "id": 121003,
  "kids": [121016, 121109, 121168],
  "score": 25,
  "text": "<i>or</i> HN: the Next Iteration<p>I get the impression that with Arc being released a lot of people who never had time for HN before are suddenly dropping in more often. (PG: what are the numbers on this? I'm envisioning a spike.)<p>Not to say that isn't great, but I'm wary of Diggification. Between links comparing programming to sex and a flurry of gratuitous, ostentatious  adjectives in the headlines it's a bit concerning.<p>80% of the stuff that makes the front page is still pretty awesome, but what's in place to keep the signal/noise ratio high? Does the HN model still work as the community scales? What's in store for (++ HN)?",
  "time": 1203647620,
  "title": "Ask HN: The Arc Effect",
  "type": "story"
}
```

**Job:**

```
GET https://hacker-news.firebaseio.com/v0/item/192327.json?print=pretty
```

```json
{
  "by": "justin",
  "id": 192327,
  "score": 6,
  "text": "Justin.tv is the biggest live video site online. We serve hundreds of thousands of video streams a day, and have supported up to 50k live concurrent viewers. Our site is growing every week, and we just added a 10 gbps line to our colo. Our unique visitors are up 900% since January.<p>There are a lot of pieces that fit together to make Justin.tv work: our video cluster, IRC server, our web app, and our monitoring and search services, to name a few. A lot of our website is dependent on Flash, and we're looking for talented Flash Engineers who know AS2 and AS3 very well who want to be leaders in the development of our Flash.<p>Responsibilities<p><pre><code>    * Contribute to product design and implementation discussions\n    * Implement projects from the idea phase to production\n    * Test and iterate code before and after production release \n</code></pre>\nQualifications<p><pre><code>    * You should know AS2, AS3, and maybe a little be of Flex.\n    * Experience building web applications.\n    * A strong desire to work on website with passionate users and ideas for how to improve it.\n    * Experience hacking video streams, python, Twisted or rails all a plus.\n</code></pre>\nWhile we're growing rapidly, Justin.tv is still a small, technology focused company, built by hackers for hackers. Seven of our ten person team are engineers or designers. We believe in rapid development, and push out new code releases every week. We're based in a beautiful office in the SOMA district of SF, one block from the caltrain station. If you want a fun job hacking on code that will touch a lot of people, JTV is for you.<p>Note: You must be physically present in SF to work for JTV. Completing the technical problem at <a href=\"http://www.justin.tv/problems/bml\" rel=\"nofollow\">http://www.justin.tv/problems/bml</a> will go a long way with us. Cheers!",
  "time": 1210981217,
  "title": "Justin.tv is looking for a Lead Flash Engineer!",
  "type": "job",
  "url": ""
}
```

**Poll:**

```
GET https://hacker-news.firebaseio.com/v0/item/126809.json?print=pretty
```

```json
{
  "by": "pg",
  "descendants": 54,
  "id": 126809,
  "kids": [126822, 126823, 126993, 126824, 126934, 127411, 126888, 127681, 126818, 126816, 126854, 127095, 126861, 127313, 127299, 126859, 126852, 126882, 126832, 127072, 127217, 126889, 127535, 126917, 126875],
  "parts": [126810, 126811, 126812],
  "score": 46,
  "text": "",
  "time": 1204403652,
  "title": "Poll: What would happen if News.YC had explicit support for polls?",
  "type": "poll"
}
```

**Pollopt:**

```
GET https://hacker-news.firebaseio.com/v0/item/160705.json?print=pretty
```

```json
{
  "by": "pg",
  "id": 160705,
  "poll": 160704,
  "score": 335,
  "text": "Yes, ban them; I'm tired of seeing Valleywag stories on News.YC.",
  "time": 1207886576,
  "type": "pollopt"
}
```

---

## Users

Only users with public activity (comments or submissions) appear in the API. User IDs are **case-sensitive**.

**Endpoint:** `/v0/user/<id>.json`

### Fields

| Field | Description |
|:------|:------------|
| `id` | Unique username, case-sensitive (required) |
| `created` | Account creation time, Unix timestamp (required) |
| `karma` | User's karma score (required) |
| `about` | Self-description (HTML) |
| `submitted` | IDs of stories, polls, and comments submitted |

### Example

```
GET https://hacker-news.firebaseio.com/v0/user/jl.json?print=pretty
```

```json
{
  "about": "This is a test",
  "created": 1173923446,
  "id": "jl",
  "karma": 2937,
  "submitted": [8265435, 8168423]
}
```

---

## Live Data

Firebase supports real-time change notifications.

### Max Item ID

The highest current item ID — walk backward to discover all items.

```
GET https://hacker-news.firebaseio.com/v0/maxitem.json
```

Returns a single integer (e.g., `9130260`).

### New, Top, and Best Stories

Up to 500 story IDs. `topstories` also includes jobs.

| Feed | Endpoint |
|:-----|:---------|
| Top Stories | `/v0/topstories.json` |
| New Stories | `/v0/newstories.json` |
| Best Stories | `/v0/beststories.json` |

Returns an array of item IDs.

### Ask, Show, and Job Stories

Up to 200 of the latest Ask HN, Show HN, and Job stories.

| Feed | Endpoint |
|:-----|:---------|
| Ask HN | `/v0/askstories.json` |
| Show HN | `/v0/showstories.json` |
| Jobs | `/v0/jobstories.json` |

Returns an array of item IDs.

### Changed Items and Profiles

Items and profiles updated in the last few minutes.

```
GET https://hacker-news.firebaseio.com/v0/updates.json
```

```json
{
  "items": [8423305, 8420805],
  "profiles": ["thefox", "rpedela"]
}
```
