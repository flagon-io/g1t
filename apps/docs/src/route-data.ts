import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

import { tabFor } from './tabs';

/** Each page's sidebar holds only its tab's groups. */
export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	const tab = tabFor(route.id);
	route.sidebar = route.sidebar.filter((entry) => entry.type === 'group' && tab.groups.includes(entry.label));
});
