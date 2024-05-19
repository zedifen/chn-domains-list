
export interface Env {
  CODE_SOURCE_URL_ROOT: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname == '/favicon.ico') {
      const cacheKey = new Request(request.url);
      const cachedResponse = await caches.default.match(cacheKey);
      if (!cachedResponse) {
        const res = await fetch('https://workers.cloudflare.com/favicon.ico');
        const favicon = new Response(res.body, {
          headers: {
            'Cache-Control': 's-maxage=86400',
            'Content-Type': res.headers.get('Content-Type') || 'image/vnd.microsoft.icon',
          },
        })
        ctx.waitUntil(caches.default.put(cacheKey, favicon.clone()));
        return favicon;
      }
      return cachedResponse;
    }

    const PATH_PREFIX = '/chn-domains-list/';

    // strip path prefix
    if (url.pathname.startsWith(PATH_PREFIX)) {
      url.pathname = url.pathname.slice(PATH_PREFIX.length - 1);
    }

    if (url.pathname.slice(1) == 'main/worker.ts' || url.pathname.slice(1) == 'alternative/worker.ts') {
      if (!env.CODE_SOURCE_URL_ROOT) {
        return new Response('Environment variable `CODE_SOURCE_URL_ROOT` is not set.', {status: 404});
      }
      try {
        const r = await fetch(env.CODE_SOURCE_URL_ROOT + url.pathname.slice(1));
        return new Response(r.body, {
          headers: {'Content-Type': 'text/plain; charset=utf-8'},
        });
      } catch (e) {
        return new Response('Failed to fetch source code.', {status: 400});
      }
    }

    const UPSTREAM_SOURCES_ROOT = 'https://raw.githubusercontent.com/felixonmars/dnsmasq-china-list/master/';

    const NAME_ALIAS: {[s: string]: string} = {
      'CHN': 'accelerated-domains.china',
      'CHN.GOOG': 'google.china',
      'CHN.AAPL': 'apple.china',
      'CHN.ALL': 'all',
    }

    const availableNames = Object.values(NAME_ALIAS).concat(Object.keys(NAME_ALIAS));
    const availableSuffixes = ['.conf', '.hosts', '.txt', '.list'];
    
    if (url.pathname == '/') {
      const listItems = [];
      for (const k of Object.keys(NAME_ALIAS)) {
        for (const f of availableSuffixes) {
          const pathname = `${NAME_ALIAS[k]}${f}`;
          const pathnameAlias = `${k}${f}`;
          listItems.push(`<li><a href="./${pathname}">${pathname}</a> (alias: <a href="./${pathnameAlias}">${pathnameAlias}</a>)</li>`);
        }
      }
      return new Response(`<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CHN Domains List</title>
        <meta name="description" content="Inspired by fernvenue's multi-formatted CHN domains list, but powered by Cloudflare Workers. Source data from felixonmars's dnsmasq-china-list.">
        <style> @media (prefers-color-scheme: dark) { body { background-color: black; color: darkgray; } } </style>
      </head>
      <h1>CHN Domains List</h1>
      <p>Powered by Cloudflare Workers. Source code: <a href="./main/worker.ts">main</a> / <a href="./alternative/worker.ts">alternative</a>.</p>
      <p>Inspired by <a href="https://github.com/fernvenue/chn-domains-list">chn-domains-list</a>, using <a href="https://github.com/felixonmars/dnsmasq-china-list">felixonmars's dnsmasq-china-list</a> as upstream.</p>
      <body><p>Avaliable resources:</p>
      <ul>${listItems.join('')}</ul>
      </body>
      </html>`, {
        headers: {
          'Content-Type': 'text/html; encoding=utf-8',
        },
      });
    }

    // extracting name and suffix part from pathname
    const pathnameLastDotPos = url.pathname.lastIndexOf('.');
    const _name = pathnameLastDotPos != -1 ? url.pathname.slice(1, pathnameLastDotPos) : url.pathname.slice(1);
    const name = NAME_ALIAS[_name] ?? _name;
    const suffix = pathnameLastDotPos != -1 ? url.pathname.slice(pathnameLastDotPos) : '';

    // generating cache key from normalized url
    const cacheKey = new Request(new URL(name + suffix, url.origin), request);
    const cachedResponse = await caches.default.match(cacheKey);

    // not returning from cache if 'noCache' presents (regardless of its value)
    if (url.searchParams.get('noCache') == null && cachedResponse) { return cachedResponse; }
    
    // filtering illegal requests
    const messages = [];

    if (availableNames.indexOf(name) == -1) {
      messages.push(`Unsupported resource name: "${_name}".\n  Available resources are: "${availableNames.join('", "')}".`);
    }
    if (availableSuffixes.indexOf(suffix) == -1) {
      messages.push(`Unsupported suffix: "${suffix}".\n  Available suffixes are: "${availableSuffixes.join('", "')}".`);
    }
    if (messages.length > 0) {
      return new Response(messages.join('\n\n'), {status: 400});
    }

    const servers: string[][] = [];

    // fetching from upstream
    for (const n of (
      name == 'all'
      ? ['accelerated-domains.china', 'apple.china', 'google.china'] 
      : [name]
    )) {
      const src = await fetch(`${UPSTREAM_SOURCES_ROOT}${n}.conf`);
      const text = await src.text();
      // pre-processing response
      servers.push(
        text
          .split('\n')
          .filter(i => i.startsWith('server'))
          .map(m => m.slice(m.indexOf('/') + 1, m.lastIndexOf('/')))
      );
    }

    // generating response for one of the formats (determined by suffix)
    const headers = new Headers({
      'Cache-Control': 's-maxage=86400',
      'Content-Type': 'text/plain; charset=utf-8',
    });

    // helper function for putting a response into cache
    function putCache(response: Response) {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      return response;
    }

    // handle resource generating for different formats (suffixes)
    switch (suffix) {
      case '.txt':
        return putCache(new Response(servers.flat().join('\n'), {headers}));
      case '.conf': {
        return putCache(new Response(
          servers.flat().map(n => `DOMAIN-SUFFIX,${n}\n`).join(''),
          { headers },
        ));
      }
      case '.list': {
        return putCache(new Response(servers.flat().map(n => `.${n}\n`).join(''), {headers}));
      }
      case '.hosts': {
        return putCache(new Response(
          '[Host]\n\n' + servers.flat().map(n => 
            `${n} = server:system\n` +
          `+.${n} = server:system\n`).join(''),
          { headers },
        ));
      }
      default:
        return new Response('never');
    }
  },
};
