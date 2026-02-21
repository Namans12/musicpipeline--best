# Rate Limit

Spotify does not publish a single, fixed number for its Web API rate limit. Instead, it uses a rolling 30-second window where the specific threshold varies based on your app's mode and the complexity of the endpoints being called.
Spotify for Developers
Spotify for Developers
 +1
Key Limit Mechanisms
Rolling 30-Second Window: Limits are calculated based on requests made in any 30-second period. If you exceed this, the API returns a 429 Too Many Requests error.
Quota Modes:
Development Mode: The default for new apps. It allows up to 25 authenticated users and is intended for testing.
Extended Quota Mode: Higher limits for apps intended for a wider audience. Developers must request an extension through the Developer Dashboard.
Endpoint Sensitivity: Some endpoints are more restricted. For example, "Ads API" reporting endpoints have a specific cap of 150 requests per 30 seconds (approx. 5 requests per second), while general calls may allow up to 1,500 per 30 seconds (50 RPS).
Spotify for Developers
Spotify for Developers
 +4
Handling Rate Limits
When you hit a limit, Spotify provides specific headers to help you manage the cooldown:
Retry-After: The number of seconds you must wait before making another request.
X-RateLimit-Remaining: The number of requests left in the current window.
X-RateLimit-Reset: The time until the current window resets.
Spotify for Developers
Spotify for Developers
 +2
Best Practices to Avoid Throttling
Use Batch APIs: Use endpoints like Get Multiple Albums or Get Multiple Artists to fetch data for many objects in a single call.
Implement Caching: Use the snapshot_id for playlists to avoid downloading data that hasn't changed.
Back-off Strategy: Design your app to automatically pause for the duration specified in the Retry-After header.
Lazy Loading: Only trigger API calls when a user actually interacts with a specific feature.
The Spotify Community
The Spotify Community
 +3
Are you currently encountering 429 errors on a specific endpoint, or are you planning a new app architecture?

Think of Spotify’s rate limit like a busy coffee shop that only lets a certain number of people in at a time so the baristas don't get overwhelmed.
Here is the "plain English" breakdown:
No "Magic Number": Spotify doesn't say "you get 100 clicks." Instead, they watch how fast you're asking for things. If you ask for 50 songs in one second, they’ll tell you to slow down.
The 30-Second Rule: They look at your activity in 30-second chunks. If you go "too fast" during those 30 seconds, you get put in time-out.
The "Time-Out" (429 Error): If you hit the limit, Spotify sends back an error called a 429. It comes with a note saying, "Wait X seconds before trying again."
App Status Matters:
New apps (Development Mode) have a very short leash. They are meant for just you and a few friends.
Big apps (Extended Quota) get much higher limits, but you have to ask Spotify for permission first.
How to stay out of "Time-Out":
Ask for groups: Don't ask for 50 songs one by one. Ask for one "bundle" of 50.
Remember things: If you just asked for a playlist 2 minutes ago, save that info on your side instead of asking Spotify again.
Listen to the timer: If Spotify says "Wait 10 seconds," make sure your code actually waits exactly 10 seconds before clicking again.

Because Spotify uses a rolling 30-second window, a "safe" number for a 330-second period is actually about staying under the limit for every 30-second slice within that time.
Spotify for Developers
Spotify for Developers
 +1
The Safe Numbers
Based on developer community testing and official documentation for different app modes, here are the recommended maximums to avoid a 429 "Too Many Requests" error:
Development Mode (Default): Aim for ~1 request per second, or 330 total requests spread evenly across your window.
Note: Community benchmarks suggest the limit is roughly 180 requests per minute.
Extended Quota Mode (Approved Apps): This allows for much higher traffic, typically up to 50 requests per second (RPS) for standard endpoints. For your 330-second window, this could technically be up to 16,500 requests, provided they are spread out.
The Spotify Community
The Spotify Community
 +3
Safe Pacing Strategy
To ensure you never get blocked, do not send all requests at once. Instead, follow these pacing rules:
Standard Endpoints: Limit yourself to ~3-5 requests per second to be extremely safe.
Intensive Endpoints: Some endpoints (like Audio Analysis) have much stricter, sometimes 24-hour, limits. Limit these to 1 request every few seconds.
Batching: Instead of making 330 individual calls, use "Get Multiple" endpoints (like Get Several Tracks) to fetch up to 50 items in one single request. This reduces your total request count by 98%.
The Spotify Community
The Spotify Community
 +4
What to watch for
If you do hit a limit, Spotify will send a Retry-After header in the response. Always make your code wait for the exact number of seconds specified in that header before trying again to avoid longer "time-outs".
Stack Overflow
Stack Overflow
 +2
Are you running a bulk data export or building a real-time player that needs constant updates?

You can stay in the "safe window" indefinitely, provided you maintain a consistent pace and handle authentication correctly. There is no daily or weekly "cap" for standard Web API usage, but there are two critical time-based factors to manage:

1. The 1-Hour Token Expiry
While the rate limit doesn't expire, your Access Token does.
Spotify for Developers
Spotify for Developers
 +1
Duration: Tokens are valid for exactly 1 hour (3600 seconds).
The Fix: You must use a Refresh Token to get a new access token every hour to keep your session running.
Spotify for Developers
Spotify for Developers
 +2
2. The 30-Second Rolling Window
As long as you don't exceed the request threshold in any moving 30-second slice, you can keep making calls 24/7.
Spotify for Developers
Spotify for Developers
 +1
Safe Pace: If you stay at or below ~3 requests per second, you are highly unlikely to ever trigger a block.
Cumulative "Punishment": If you do hit a limit and keep trying without waiting, Spotify may "punish" you by increasing your wait time significantly. Some developers have reported being locked out for 21+ hours after ignoring multiple rate limit errors.
The Spotify Community
The Spotify Community
 +4
Summary of Duration
Factor  Limit / Duration Action Required
Total Requests Unlimited None, as long as you pace them.
Access Token 1 Hour Use a Refresh Token to renew.
Rate Limit Window Rolling 30 Seconds Stay below ~180 requests per minute.
Cooldown (if blocked) Varies (Seconds to Hours) Wait for the exact time in the Retry-After header.
Pro Tip: For long-running scripts, use exponential backoff—if you get an error, wait a little; if you get it again, wait twice as long.
Postman Blog
Postman Blog
 +1
These technical guides address handling Spotify API rate limits, including the 30-second rolling window and how to interpret the "Retry-After" header for cooldown periods.
