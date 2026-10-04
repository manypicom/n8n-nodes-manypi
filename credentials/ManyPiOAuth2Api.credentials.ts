import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Sign in with a ManyPI account instead of pasting an API key.
 *
 * ManyPI's authorization server supports dynamic client registration, so n8n
 * registers itself on the first Connect with this instance's own callback URL
 * and uses PKCE. Nobody has to create an OAuth app or copy a client ID. Needs
 * n8n 1.119 or later, the first release with dynamic client registration.
 */
export class ManyPiOAuth2Api implements ICredentialType {
	name = 'manyPiOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'ManyPI OAuth2 API';

	icon: Icon = { light: 'file:../icons/manypi.svg', dark: 'file:../icons/manypi.dark.svg' };

	documentationUrl = 'https://github.com/manypicom/n8n-nodes-manypi#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Use Dynamic Client Registration',
			name: 'useDynamicClientRegistration',
			type: 'hidden',
			default: true,
		},
		{
			// The authorization server's issuer. n8n reads its
			// /.well-known/oauth-authorization-server document for the authorize,
			// token and registration endpoints.
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'hidden',
			default: 'https://rtedeohuyuwawyvamvyf.supabase.co/auth/v1',
		},
	];
}
