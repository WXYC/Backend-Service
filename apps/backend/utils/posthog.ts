import { PostHog } from 'posthog-node';

let postHogClient: PostHog | null = null;

export function getPostHogClient(): PostHog {
  if (!postHogClient) {
    postHogClient = new PostHog(process.env.POSTHOG_API_KEY ?? '', {
      host: 'https://us.i.posthog.com',
    });
  }
  return postHogClient;
}
