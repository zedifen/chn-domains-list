
export interface Env {
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
        <style> @media (prefers-color-scheme: dark) { body { background-color: black; color: darkgray; } } </style>
      </head>
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
    const cacheKey = new Request(new URL(name + suffix, 'https://chn-domains-list.hw388.workers.dev'), request);
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

    const slices: [number, number, number][] = [];
    const texts: Uint8Array[] = [];
    let slicesTotalLength = 0;
    let textN = 0;
    const returnCharCode = '\n'.charCodeAt(0);
    const dotCharCode = '.'.charCodeAt(0);

    // fetching from upstream
    for (const n of (
      name == 'all'
      ? ['accelerated-domains.china', 'google.china', 'apple.china'] 
      : [name]
    )) {
      const src = await fetch(`${UPSTREAM_SOURCES_ROOT}${n}.conf`);
      const text = new Uint8Array(await src.arrayBuffer());
      // pre-processing response
      let i = 0;
      const slashCode = '/'.charCodeAt(0);
      const matcher = 'server'.split('').map(i => i.charCodeAt(0));
      function match(text: Uint8Array, a: number, matcher: number[]) {
        for (let i = 0; i < matcher.length; i += 1) {
          if (text[a + i] != matcher[i]) return false;
        }
        return true;
      }
      while (i < text.length) {
        if (match(text, i, matcher)) {
          i += matcher.length;
          while (text[i] != slashCode /* && i < text.length && text[i] != '\n'.charCodeAt(0) */) i += 1;
          i += 1;
          const a = i;
          while (text[i] != slashCode /* && i < text.length && text[i] != '\n'.charCodeAt(0) */) i += 1;
          const b = i;
          i += 1;
          slices.push([textN, a, b]);
          slicesTotalLength += (b - a);
        }
        while (text[i] != returnCharCode && i < text.length) i += 1;
        i += 1;
      }
      texts.push(text);
      textN += 1;
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
      case '.txt': {
        const a = new Uint8Array(slicesTotalLength + slices.length);
        let i = 0;
        for (const [n, x, y] of slices) {
          for (let q = x; q < y; q += 1) { a[i++] = texts[n][q]; }
          a[i++] = returnCharCode;
        }
        return putCache(new Response(a, {headers}));
      }
      case '.conf': {
        const prefix = 'DOMAIN-SUFFIX,'.split('').map(i => i.charCodeAt(0));
        const a = new Uint8Array(slicesTotalLength + (prefix.length + 1) * slices.length);
        let i = 0;
        for (const [n, x, y] of slices) {
          for (const c of prefix) { a[i++] = c; }
          for (let q = x; q < y; q += 1) { a[i++] = texts[n][q]; }
          a[i++] = returnCharCode;
        }
        return putCache(new Response(a, {headers}));
      }
      case '.list': {
        const a = new Uint8Array(slicesTotalLength + 2 * slices.length);
        let i = 0;
        for (const [n, x, y] of slices) {
          a[i++] = dotCharCode;
          for (let q = x; q < y; q += 1) { a[i++] = texts[n][q]; }
          a[i++] = returnCharCode;
        }
        return putCache(new Response(a, {headers}));
      }
      case '.hosts': {
        const s = '[Host]\n\n'.split('').map(i => i.charCodeAt(0));
        const p = ' = server:system\n'.split('').map(i => i.charCodeAt(0));
        const q = '+.'.split('').map(i => i.charCodeAt(0));
        const a = new Uint8Array(s.length + slicesTotalLength * 2 + (2 * p.length + q.length) * slices.length);
        let i = 0;
        for (const c of s) { a[i++] = c; }
        for (const [n, x, y] of slices) {
          for (let q = x; q < y; q += 1) { a[i++] = texts[n][q]; }
          for (const c of p) { a[i++] = c; }
          for (const c of q) { a[i++] = c; }
          for (let q = x; q < y; q += 1) { a[i++] = texts[n][q]; }
          for (const c of p) { a[i++] = c; }
        }
        return putCache(new Response(a, {headers}));
      }
      default:
        return new Response('never');
    }
  },
};
