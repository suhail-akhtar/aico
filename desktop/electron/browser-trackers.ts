/**
 * Tracker blocking for the built-in browser — the pure half: the list and the
 * matching rules. `browser-net.ts` applies it to the browser partition's
 * requests.
 *
 * The list is a compact, curated set of well-known third-party analytics,
 * advertising, fingerprinting and session-recording hosts (the core of what
 * Disconnect / EasyPrivacy block by name). A request is blocked only when:
 *
 *   - it is not a main-frame navigation (a page you open is never blocked), and
 *   - its host is, or is under, a listed domain, and
 *   - it is third-party: its registrable domain differs from the page's
 *     (google-analytics.com loading on google-analytics.com is left alone).
 *
 * Human-check providers (reCAPTCHA, hCaptcha, Turnstile) and CDNs are
 * deliberately NOT on the list: blocking them would break sign-ins.
 *
 * @module desktop/electron/browser-trackers
 */

export const TRACKER_DOMAINS: readonly string[] = [
  // Google advertising and analytics
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'googleadservices.com', 'googlesyndication.com',
  'doubleclick.net', 'adservice.google.com', 'pagead2.googlesyndication.com', 'app-measurement.com',
  'firebaselogging-pa.googleapis.com', 'analytics.google.com', 'stats.g.doubleclick.net', 'admob.com', 'invitemedia.com',
  // Meta / social
  'connect.facebook.net', 'pixel.facebook.com', 'an.facebook.com', 'graph.instagram.com', 'ads-twitter.com',
  'analytics.twitter.com', 'static.ads-twitter.com', 'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com',
  'analytics.tiktok.com', 'ads.tiktok.com', 'business-api.tiktok.com', 'ct.pinterest.com', 'analytics.pinterest.com',
  'sc-static.net', 'tr.snapchat.com', 'ads.reddit.com', 'events.redditmedia.com', 'alb.reddit.com', 'pixel.quora.com',
  'ads.yahoo.com', 'analytics.yahoo.com', 'sp.analytics.yahoo.com', 'bat.bing.com', 'clarity.ms', 'c.clarity.ms',
  'ads.microsoft.com', 'c.bing.com', 'adnxs.com', 'adnxs-simple.com', 'atdmt.com',
  // Amazon ads
  'amazon-adsystem.com', 'assoc-amazon.com', 'aax.amazon-adsystem.com',
  // Product analytics / session replay
  'hotjar.com', 'hotjar.io', 'static.hotjar.com', 'mouseflow.com', 'fullstory.com', 'logrocket.com', 'lr-ingest.io',
  'lr-in.com', 'luckyorange.com', 'luckyorange.net', 'crazyegg.com', 'inspectlet.com', 'smartlook.com', 'smartlook.cloud',
  'quantummetric.com', 'contentsquare.net', 'contentsquare.com', 'clicktale.net', 'decibelinsight.net', 'glassboxdigital.io',
  'heap.io', 'heapanalytics.com', 'mixpanel.com', 'mxpnl.com', 'mxpnl.net', 'segment.com', 'segment.io', 'cdn.segment.com',
  'api.segment.io', 'amplitude.com', 'api.amplitude.com', 'api2.amplitude.com', 'cdn.amplitude.com', 'kissmetrics.com',
  'kissmetrics.io', 'pendo.io', 'woopra.com', 'chartbeat.com', 'chartbeat.net', 'parsely.com', 'parse.ly', 'statcounter.com',
  'clicky.com', 'getclicky.com', 'static.getclicky.com', 'mc.yandex.ru', 'mc.yandex.com', 'top-fwz1.mail.ru', 'counter.yadro.ru',
  'hm.baidu.com', 'cnzz.com', 'umeng.com', 'newrelic.com', 'nr-data.net', 'js-agent.newrelic.com', 'bam.nr-data.net',
  'optimizely.com', 'cdn.optimizely.com', 'logx.optimizely.com', 'vwo.com', 'visualwebsiteoptimizer.com', 'abtasty.com',
  'kameleoon.com', 'kameleoon.eu', 'omtrdc.net', '2o7.net', 'demdex.net', 'everesttech.net', 'adobedtm.com',
  'sc.omtrdc.net', 'tt.omtrdc.net', 'mktoresp.com', 'munchkin.marketo.net', 'hs-analytics.net', 'hs-banner.com',
  'hsadspixel.net', 'hsleadflows.net', 'track.hubspot.com', 'pi.pardot.com',
  'bizible.com', 'bizibly.com', 'eloqua.com', 'en25.com', 'reveal.clearbit.com',
  'leadfeeder.com', 'lfeeder.com', 'albacross.com', 'zoominfo.com', 'ws.zoominfo.com', 'sixsense.com', 'j.6sc.co', 'b.6sc.co',
  'demandbase.com', 'tag.demandbase.com', 'bombora.com', 'ml314.com', 'rlcdn.com', 'rlets.com', 'liveramp.com',
  'krxd.net', 'bluekai.com', 'exelator.com', 'eyeota.net', 'lotame.com', 'crwdcntrl.net', 'tapad.com', 'agkn.com',
  'adsrvr.org', 'thetradedesk.com', 'mathtag.com', 'mediamath.com', 'bidswitch.net', 'casalemedia.com', 'indexww.com',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'openx.com', 'contextweb.com', 'sovrn.com', 'lijit.com', 'yieldmo.com',
  'sharethrough.com', 'triplelift.com', '3lift.com', 'teads.tv', 'smartadserver.com', 'adform.net', 'adformdsp.net',
  'criteo.com', 'criteo.net', 'emxdgt.com', 'gumgum.com', 'media.net', 'spotxchange.com', 'spotx.tv', 'springserve.com',
  'districtm.io', 'adcolony.com', 'applovin.com', 'unityads.unity3d.com', 'inmobi.com', 'mopub.com', 'chartboost.com',
  'vungle.com', 'ironsrc.com', 'adsafeprotected.com', 'moatads.com', 'moatpixel.com', 'doubleverify.com', 'iasds01.com',
  'serving-sys.com', 'flashtalking.com', 'sizmek.com', 'innovid.com', 'tremorhub.com', 'yieldlab.net', 'adition.com',
  'adhigh.net', 'stickyadstv.com', 'zemanta.com', 'revcontent.com', 'mgid.com', 'taboola.com', 'taboolasyndication.com',
  'outbrain.com', 'outbrainimg.com', 'zergnet.com', 'content.ad', 'nativo.com', 'plista.com', 'ligatus.com',
  'scorecardresearch.com', 'comscore.com', 'imrworldwide.com', 'nielsen.com', 'quantserve.com', 'quantcount.com',
  'quantcast.com', 'alexametrics.com', 'effectivemeasure.net', 'gemius.pl', 'hit.gemius.pl', 'xiti.com', 'atinternet.com',
  'webtrends.com', 'webtrendslive.com', 'coremetrics.com', 'cmcore.com', 'tealiumiq.com', 'tiqcdn.com', 'ensighten.com',
  'nexus.ensighten.com', 'bounceexchange.com', 'bouncex.net', 'wunderkind.co', 
  'addthis.com', 'addthisedge.com', 'sharethis.com', 'po.st', 'shareaholic.com', 'disqusads.com', 'zqtk.net',
  'branch.io', 'appsflyer.com', 'adjust.com', 'kochava.com', 'singular.net', 'tenjin.io',
  'impactradius-event.com', 'ojrq.net', 'sjv.io',
  'awin1.com', 'zenaps.com', 'dwin1.com', 'cj.com', 'emjcd.com', 'anrdoezrs.net', 'dpbolvw.net', 'jdoqocy.com',
  'kqzyfj.com', 'tkqlhce.com', 'qksrv.net', 'linksynergy.com', 'rakuten-marketing.com', 'shareasale.com',
  'shareasale-analytics.com', 'pepperjam.com', 'pjtra.com', 'pntra.com', 'avantlink.com', 'skimlinks.com', 'skimresources.com',
  'viglink.com', 'redirectingat.com', 'go.redirectingat.com', 'partnerize.com', 'prf.hn', 'tradedoubler.com', 'webgains.com',
  'everflow.io', 'tapfiliate.com', 'refersion.com', 'friendbuy.com', 'extole.com', 'curalate.com',
  'adriver.ru', 'adfox.ru', 'begun.ru', 'tns-counter.ru',
  'adskeeper.co.uk', 'adsterra.com', 'propellerads.com', 'popads.net', 'popcash.net', 'exoclick.com', 'juicyads.com',
  'trafficjunky.net', 'trafficstars.com', 'hilltopads.net', 'clickadu.com', 'adcash.com', 'admaven.com', 'onclickads.net',
  'zedo.com', 'yieldlove.com', 'yieldlove-ad-serving.net', 'adrecover.com', 'admixer.net', 'adtelligent.com', 'undertone.com',
  'conversantmedia.com', 'dotomi.com', 'fastclick.net', 'valueclick.com', 'advertising.com', 'adtech.de', 'adtechus.com',
  'bidr.io', 'beeswax.com', 'simpli.fi', 'sitescout.com', 'steelhousemedia.com', 'dstillery.com',
  'media6degrees.com', 'owneriq.net', 'rfihub.com', 'rfihub.net', 'turn.com', 'mookie1.com', 'adgrx.com', 'rtbhouse.com',
  'creativecdn.com', 'rtb-house.com', 'advertising.yahoo.com', 'gemini.yahoo.com', 'onebyaol.com',
  'intentiq.com', 'id5-sync.com', 'uidapi.com', 'liadm.com', 'connectid.analytics.yahoo.com',
  'permutive.com', 'permutive.app', 'cdn.permutive.com', 'cxense.com', 'npttech.com',
  'blueconic.net', 'evergage.com', 'monetate.net', 'dynamicyield.com', 'rlcdn.net',
  'richrelevance.com', 'certona.net', 'brightedge.com', 'cquotient.com', 'dc-storm.com', 'channeladvisor.com',
  'foresee.com', 'foreseeresults.com', 'kampyle.com', 'qualaroo.com', 'iperceptions.com',
  'opinionlab.com', 'usabilla.com', 'getsitecontrol.com', 'sumo.com', 'sumome.com', 
  'justuno.com', 'optinmonster.com', 'omappapi.com', 'wisepops.com', 'exponea.com', 
  'appboy.com', 'a.klaviyo.com',
  'track.customer.io', 
  'trackjs.com', 'errorception.com',
  'speedcurve.com', 'lognormal.net', 'go-mpulse.net', 'mpulse.net', 'akstat.io', 'cloudflareinsights.com',
  'static.cloudflareinsights.com', 'matomo.cloud', 'piwik.pro', 'piwikpro.com',
  'mouseflow.net', 'userzoom.com', 'hotjar.net', 'survicate.com', 
  'callrail.com', 'calltrk.com', 'callrail.net',
  'marchex.io', 'invoca.net', 'invocacdn.com', 'dialogtech.com', 'convertro.com', 'visualiq.com', 'c3tag.com',
  'adroll.com', 'd.adroll.com', 'perfectaudience.com', 'retargeter.com', 'chango.com', 'fetchback.com', 'criteo.fr',
  'omnitagjs.com', 'adotmob.com', 'weborama.fr', 'weborama.com', 'mediarithmics.com', 'ad6media.fr', 'sddan.com',
  'teads.com', 'ayads.co', 'seedtag.com', 'outbrain.org', 'ads.pubmatic.com', 'ib.adnxs.com', 'secure.adnxs.com',
  'cdn.taboola.com', 'trc.taboola.com', 'widgets.outbrain.com', 'log.outbrain.com', 'b.scorecardresearch.com',
  'sb.scorecardresearch.com', 'pixel.adsafeprotected.com', 'z.moatads.com', 'cdn.doubleverify.com', 'tps.doubleverify.com',
];

/**
 * Suffixes where a registrable domain needs three labels (example.co.uk).
 * Not the whole Public Suffix List — the common ones, which is enough to keep
 * a site's own subdomains first-party.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'ac.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.ar', 'com.mx', 'gob.mx', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in', 'gen.in', 'ind.in', 'res.in',
  'com.pk', 'net.pk', 'org.pk', 'edu.pk', 'gov.pk', 'com.bd', 'com.lk', 'com.np',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.sg', 'edu.sg', 'gov.sg',
  'com.my', 'com.ph', 'com.vn', 'co.th', 'in.th', 'co.id', 'or.id', 'ac.id', 'go.id',
  'com.tr', 'gov.tr', 'org.tr', 'com.sa', 'com.eg', 'co.il', 'org.il', 'ac.il', 'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.ng', 'co.ke', 'or.ke', 'co.tz', 'co.ug', 'com.gh', 'com.ua', 'org.ua', 'com.ru', 'net.ru', 'org.ru', 'com.pl', 'net.pl',
  'co.at', 'or.at', 'com.es', 'com.pt', 'com.gr', 'co.it', 'com.qa', 'com.kw', 'com.om', 'com.bh', 'ae.org',
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com', 'wordpress.com',
]);

const TRACKERS = new Set(TRACKER_DOMAINS.map(d => d.toLowerCase()));

/** The number of distinct, real domains on the list. */
export function trackerCount(): number { return TRACKERS.size; }

const isIp = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/** The part of a host a site owns: news.bbc.co.uk → bbc.co.uk, a.b.example.com → example.com. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || isIp(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

/** The listed tracker domain a host falls under, or null. */
export function trackerDomainFor(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || isIp(h)) return null;
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    if (TRACKERS.has(cand)) return cand;
  }
  return null;
}

export interface BlockDecision { block: boolean; tracker?: string }

/**
 * Should this request be blocked?
 *
 * @param requestUrl  the request
 * @param pageUrl     the top-level page it was made for ('' when unknown)
 * @param resourceType Electron's resourceType ('mainFrame' is never blocked)
 */
export function shouldBlock(requestUrl: string, pageUrl: string, resourceType: string): BlockDecision {
  if (resourceType === 'mainFrame') return { block: false };
  let reqHost: string;
  try {
    const u = new URL(requestUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return { block: false };
    reqHost = u.hostname;
  } catch { return { block: false }; }
  const tracker = trackerDomainFor(reqHost);
  if (!tracker) return { block: false };
  let pageHost = '';
  try { pageHost = pageUrl ? new URL(pageUrl).hostname : ''; } catch { /* no page yet */ }
  // First party: the site's own analytics host (or the tracker's own site) is not blocked.
  if (pageHost && registrableDomain(pageHost) === registrableDomain(reqHost)) return { block: false };
  return { block: true, tracker: reqHost.toLowerCase() };
}

/** The origin (scheme://host[:port]) of a URL, or '' for non-web URLs. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch { return ''; }
}
