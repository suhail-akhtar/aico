/**
 * Text measurement for the deck layout engine — the advance width of every
 * printable ASCII character (and a few typographic ones) in each font a deck
 * theme uses, regular and bold, in thousandths of an em.
 *
 * ## Why a table and not a browser
 *
 * The layout engine decides where lines wrap and how far a box must shrink,
 * and the Canvas tool validates decks with it on every write — in Node, with
 * no DOM and often no browser installed. Wrapping by "average character
 * width" was the first idea and is wrong exactly where it matters: a title in
 * capitals or a bullet full of `m`s and `w`s is a third wider than average and
 * overflows in PowerPoint. Per-glyph advances make the wrap the same one the
 * browser and PowerPoint compute from the same font files, to within kerning.
 *
 * The numbers were measured once with headless Chrome's `measureText` at
 * 1000 px against the fonts installed with Windows and Office (the fonts the
 * themes name). A character not in the table falls back to the font's average
 * (CJK and emoji to a full em); a font not in the table to Segoe UI's numbers
 * widened by 5%, so an unknown font errs towards wrapping early.
 *
 * Not modelled: kerning (PowerPoint applies it only above a size the files we
 * write do not set), ligatures, and fallback fonts for missing glyphs.
 *
 * @module shared/ui/canvas/deck-fonts
 */

const CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~•–—‘’“”…€£→✓×·°±";
const TABLE: Record<string, [string, string]> = {
  "Segoe UI": ['7m7wawgfezmqm86e8e8eblj061b461auezezezezezezezezezez6161j0j0j0cgqjhxfxh7jhe2dkj2jq7e9xg4d3oykskyfkkygmerekj3h9pygefdfu8eaj8ej0bj7ge5gccugdej8pgdfq6q6qdt6qnxfqgagcgd9obs9ffqdbk3crdgck8e6n8ej0badwrs6d6dahahkdezeznzktj061ahj0', '7o93dpggfzo3nm85a9a9cnjn7jb87jcbfzfzfzfzfzfzfzfzfzfz7j7jjnjnjnc6qijjhthckhesegjrla8tcdi1e7qllyl2h2l2i5flgak3ijrxi7gvgva9c4a9jnbj8qeyh8dch7f1anh7gq7w7wfj7wpggtgzh8h7b2c8atgtf2m5fceydba992a9jnbqdwrs8282dpdppcfzfznzktjn7jakjn'],
  "Segoe UI Semibold": ['7n8gc6gfffncjv769898c2ja6pb66pbiffb6ffffg0fffiewfffi6p6pjajajaccqjingsh9jxeedyjdkf84b0gzdlpolbl0g8l0hbf4fcjjhuquh7g1gb98b998jabj81eigrd2grer9lgrg67979el79omg7glgrgraabza1g7e3l0dxe4cw987q98jabidwrs7474bxbxmlffffnzktja6paija', '7n8gc6gfffncjv769898c2ja6pb66pbiffb6ffffg0fffiewfffi6p6pjajajaccqjingsh9jxeedyjdkf84b0gzdlpolbl0g8l0hbf4fcjjhuquh7g1gb98b998jabj81eigrd2grer9lgrg67979el79omg7glgrgraabza1g7e3l0dxe4cw987q98jabidwrs7474bxbxmlffffnzktja6paija'],
  "Segoe UI Light": ['7m7w9bgseblsjd5y7u7ubai266b266a6eb9webeberebebdvebeb6666i2i2i2byq8hhf4h9iqdwcxikit6c90encqn5jpl5f4kyffdte7i0gsovfnf0fu7ua67ui2bj6wdqfkccfke17ofkev5p5pcc5pmuevflfkfk96as89evclitbpclcw7u6a7ui2b0dwrs5y5y9b9biiebebnzkti266aqi2', '7m7w9bgseblsjd5y7u7ubai266b266a6eb9webeberebebdvebeb6666i2i2i2byq8hhf4h9iqdwcxikit6c90encqn5jpl5f4kyffdte7i0gsovfnf0fu7ua67ui2bj6wdqfkccfke17ofkev5p5pcc5pmuevflfkfk96as89evclitbpclcw7u6a7ui2b0dwrs5y5y9b9biiebebnzkti266aqi2'],
  "Georgia": ['6p97bghvgympjq5zafafd4hv7iae7id1h2byfjfcfpeofqdygkfq8p8phvhvhvdbptini6hukti5gnk5mnaueejagsprlbkogykojiflh7l0ijr4jqh3gqafd1afhvhvdwe0fkcmfydf91e5g68584ew7yohgfezfvfkbec09lfzdtkhe1doccbyafbyhvaxhvnt6b6bbebemfhuhafakthv7rbnhv', '72age6jjhtofm77hcfcfdejj94aj94d4jhdmhehdi1gni0feisi0a7a7jjjjjjf8qvl2l1jvn6k1inmfpdcegjmpj2sfnbmsjhmsm5i1j0n5l6vamhkcj5cfd4cfjjjjdwgkhyeriffwaxg1iw9u9mhk9ks8j6hoiai0ege9b1itfrnzgcfmeldwasdwjjc6jjps7h7hefefq6jvj6faktjj9ebojj'],
  "Arial": ['7q7q9vfgfgopij5b9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg7q7qg8g8g8fgs7ijijk2k2ijgzlmk27qdwijfgn5k2lmijlmk2ijgzk2ijq8ijijgz7q7q7qd1fg99fgfgdwfgfg7qfgfg6666dw66n5fgfgfgfg99dw7qfgdwk2dwdwdw9a789ag89qfgrs66669999rsfgfgrsktg899b4f9', '7q99d6fgfgopk26m9999atg87q997q7qfgfgfgfgfgfgfgfgfgfg9999g8g8g8gzr3k2k2k2k2ijgzlmk27qfgk2gzn5k2lmijlmk2ijgzk2ijq8ijijgz997q99g8fg99fggzfggzfg99gzgz7q7qfg7qopgzgzgzgzatfg99gzfglmfgfgdwat7satg89qfgrs7q7qdwdwrsfgfgrsktg899b4f9'],
  "Trebuchet MS": ['8da791ekekgojm4ga7a7a7eka7a7a7ekekekekekekekekekekeka7a7ekekeka7lfgefqgmh1ewelisi67qd9g0e2jphqiqfiisg6ddg5i0gbnofhfufaa79va7ekekekelfhdrfhf5aadyf67xa7e087n2f6exfhfhatb9b0f6dmkodxdpd7a7eka7ekeka7kea7a7ekekkeekekfakteka7ekek', '8da7a7gagaj0jm6da7a7c0gaa7a7a7augagagagagagagagagagaa7a7gagagac6lfhlgjh0hvftg7inj07qeth5fdkpijjjgbjpgze7h0iuhaokgph1fkb69vb6gagagaetg6e8g5fzaadygh8aa7f887nvgefqg7g8bvbzb0gfenlsfceueoc2gac2gaeka7kea7a7gagakegaekfaktgaa7gaga'],
  "Verdana": ['9saycrmqhotwk77hcmcmhomqa4cma4cmhohohohohohohohohohocmcmmqmqmqf5rsj0j2jelfhkfzljkvbpcnj9fhnfkslvgrlvjbj0h4kcj0rhj1h3j1cmcmcmmqhohogphbehhbgk9shbhl7m9kgg7mr1hlgvhbhbbvehayhlggmqggggelhncmhnmqf5hors7h7hcrcrmqhohofaktmqa4f2mq', '9ib6gbo3jrzcny98f3f3jro3a1dca1j5jrjrjrjrjrjrjrjrjrjrb6b6o3o3o3h5qslkl6k4n2izi2mjn9f6fflfhpqcnjnmkdnmlqjqiymkl8vcl8khj8f3j5f3o3jrjrikjfgcjfigbqjfjs9ib7in9itejsj3jfjfdtghcojsi2r7ili3gljrf3jro3jrjrrs9898gbgbt5jrjrfakto3a1gbo3'],
  "Calibri": ['6a92b5due3jviy658f8fdudu6y8i70aqe3e3e3e3e3e3e3e3e3e37g7gdududucvoug3f4eth3dkcrhjhb708vegbonrhyieedipf3crdjhufroqefdjd08jaq8jdudu83dbelbreldu8hd3el6d6ncn6dm7elenelel9pav9belckjvc1claz8qcs8qdududup56y6ybmbmj6e3e3p5ktdu709fdu', '6a92c6due3k9jl6h8o8odudu768i7fbye3e3e3e3e3e3e3e3e3e37o7odududucvoyguflephidkcrhphj7f97f7broaibisesj2fnd5dri5gfp6fbegda91by91dudu8cdqexbmexdz8sd6ex6u73dc6umlexeyexex9vb39nexd5kpcrd6b19kd79kdududup57676c3c3jre3e3p5ktdu7g9idu'],
  "Cambria": ['647yaxh7e2oqj46lamambvfe5p985pdmfefefefefefefefefefe7c7cfefefebqolhbgzfniefzexgzj3908jhhexmnixi5fsi5h9dsghi0gsplfvfuey9qdm9qfeab7xdkf7c9ffdk8fdqfc7q7eek7jn4fierfgf7biby9efce0lidfe0cnar8sarjscbdwrs6565afafkwhgeonaktfe7uaffe', '649bbqh6f3r4kk6zbcbcclgg6g9d6ge1gggggggggggggggggggg7s7sggggggckpli4i3fxjlg2fbhyk29q9hiyfbniivjbh2jbiee9hrishmqph7gsfqa8e1a8ggab7xevgfd1gler92eggl8q8egg8koqgsftglgfctcra5glerm6elerdbax8waxggcbdwrs6j6jb2b2lghsfgnaktgg7oaigg'],
  "Garamond": ['6y63baijcgmvk94x8484bvij638p63dwd1d1d1d1d1d1d1d1d1d16363ijijija5phith3hnlfi8fnlfl49u99kkfxn5lflpfnlfhddbh3joitoljei8i87jdw7jdwdw99bae6bldwbl8zcge66d6dd16dlfe6e6e6dm99a584dmd1ijcqblbvdbdwdbij9udwrs6363cgcgrsd1fxrsktij99b0ij', '6y78fcijd1n5ma7t9u9udmij789978fcd1b0d1d1d1d1d1d1d1d17878ijijijblpri8ititlpjoh3k9o1b0afithnphngm0h3m0jee6j4l4ijowj4i8ija5fca5g7dw99dbfcd1fcd18ef2fc7t78er78ngfcehfcfc9kbl8pfccqjodwd1d1b0f2b0ij9udwrs6y6ydmdmrsd1itrsktij99b0ij'],
  "Century Gothic": ['7p878lk0feljl15ia9a9btgu7p987pc5fefefefefefefefefefe7p7pgugugugfo3kkfymlkoewdho8iz6adegfcupjkko5ggo7gvdubui7jiqogxggdc9rgt9riodwaiiziyhzj1i28qipgy5k5ndy5kq2gyi7iyiy8das9fgwfen3dcewbt9rio9rgugudwrs9r9rdydgrsfefersktgu99b4f9', '7s7sa0gofknwiw64akakc8go7sbo7scsfkfkfkfkfkfkfkfkfkfk7s7sgogogofkkkkkg4lojgegdcnciw7sdch8c8p0kkncfkncg4egbohsjgp0iwh8dw8whs8wgodwboicichsichs7sicgo6o78g46oq4gohsicic8wc88cgofkm8fkg4cs9ggo9ggogodwrs7s7sdcdcrsfkfkrsktgo99b4f9'],
  "Franklin Gothic Medium": ['6y86abgagaj5jy5e8585gaga757575evgagagagagagagagagaga7575gagagae6llgwi3hfi0fufehui082alhidznwhyhrgshwi9g5dli1fgo9goehg285ev85dwdwdwf2f4e8f0ev8wfdf47d7hf37dmwf9evf0f49nd59sf2cjk1dqcdbw85dw85gaijgaij7575c6c6m0gagarsktga47gaga', '6y86abgagaj5jy5e8585gaga757575evgagagagagagagagagaga7575gagagae6llgwi3hfi0fufehui082alhidznwhyhrgshwi9g5dli1fgo9goehg285ev85dwdwdwf2f4e8f0ev8wfdf47d7hf37dmwf9evf0f49nd59sf2cjk1dqcdbw85dw85gaijgaij7575c6c6m0gagarsktga47gaga'],
  "Palatino Linotype": ['6y7qabdbdwnclm5s9999atdw6y996y8wdwdwdwdwdwdwdwdwdwdw6y6ydwdwdwccizlmgzjpligzfgl7n49d99k6gzqan3lugsluikelh1lmk2rsijijij99gu99dwdw99dwfdccgzdb99fgg6836ifg83ojg6f6gpfkazbs92grfpn6ecfgdw99dw99dwgudwrs7q7qdwdwrsdwdwfaktdw6yb4dw', '6y7qapdddwopn56b9999ccdw6y996y88dwdwdwdwdwdwdwdwdwdw6y6ydwdwdwccjdlmidk2n3gufin5n5atatlegursn5n5gyn5jugzijlmlmrsijijij998899dwdw99dwgzccgzdwatfggz9999gz99opgzfggzgzatcc99gzfgn5dwfgdw8mdw8mdwgudwrs7q7qdwdwrsdwdwfaktdw6yb4dw'],
  "Bahnschrift": ['7h7jaihcg1j3i44y9f9fbyeo6bdb6baifc99edepftf4e9dzfne96b6bbscrbxc0oqhzhyh7i8gmfjhyiv7ne1hufxlnjghyhbi9i4h4ddi7gbnjfrdzf486ai86dzc486esf4duezew8tezfj6z7gep82nsfjf5f4ezbvef92fgdwlheddfdra07na0ea7pfins4y4y8v8vg7higgfaktdz5wa4eo', '7h7jaihcg1j3i44y9f9fbyeo6bdb6baifc99edepftf4e9dzfne96b6bbscrbxc0oqhzhyh7i8gmfjhyiv7ne1hufxlnjghyhbi9i4h4ddi7gbnjfrdzf486ai86dzc486esf4duezew8tezfj6z7gep82nsfjf5f4ezbvef92fgdwlheddfdra07na0ea7pfins4y4y8v8vg7higgfaktdz5wa4eo'],
  "Rockwell": ['6y84baijf2qxit4xafafehij849u84c6f2f2f2f2f2f2f2f2f2f28484ijijijd1s2jeg7l4k9hdfcmajo8p8phdehobjzmafxmagserfxitjorsi8hyfnafc6afd1dw99erhyehhdfx84hdfx8484fx84o1fxfxhdh3blcq8efnf2lffcfncg99en99g79udwrs8484ehehrsf2f2faktijfab0ij', '6y9ufcikfnprma7t9k9kfxik9u9k9ue4fcfcfcfcfcfcfcfcfcfc9u9uikikikfnr7jejelpmaijhyngl4bvbalphysym0nqijnqk9erititjerikkjehyble4blg7dw99g7hdfnhdfx9uhdhd9u9uhy9urihdfxhdhdcge69khdfxmlfngierapgzapg79udwrs9u9ugigirsfcfxfaktikfab0ik'],
  "Gill Sans MT": ['7q7j9ug8f2ishd588z8zblg8638z637tdwdwdwdwdwdwdwdwdwdw636dg8g8g899s2ijfnjokudwd1kkk96y6yi8dmlplpmve6mvgscqgsjogssyjogshy997t99d1fc99bvdwc6e6db6ybvdw6363db63lfdwfcdwdwb0ap99dwc6jzdwc6bl997899g79udwrs6363bvbvrsgyerfaktg899b0g8', '7q7jdbg8f2jzku6oapapd1g87j997j7tfcfcfcfcfcfcfcfcfcfc7j7jg8g8g8afr7lpjelfmahngsmln59999jzh3olngobi8obitgsjzmvjzwfmljojec67tc6g8dw99erg7dwg7fc8ef2g77j7jfc7jqmg7gig7g7cgbvbag7e6lpfce6ehap7tapg89udwrs7j7jfnfnrshfehfaktg899b0g8'],
  "Constantia": ['6z7n9zfcc8mtit5ia9a9c1fc749z74b7ez8pdgcperd8f1dfexf67474fcfcfcc3nfiqgli3kvg5ezjhlz9g8pibfgp5ktmcg6mchje6h1koinsci9ghg19lb79lfcdwbedcfhctfrdb8me4g47v7dev7to2g6f1fkfdanb99tftdfkcdcdddc9s9o9sfc8pdwrs5r5ra3a3k1ecdgfaktfc749jfc', '6n8ha4fcc3mtk65naqaqc8fc7y9q7yb7g1a5dhcpejczf8d4evf67y7yfcfcfccmohilidiclygqfnkkn0ava3kbg1pzl0n1hun0jlenh9lbifr9j2h5gd9vb79vfcdwbeewgxdgh8ey9uf5hp988qgx95q0hsgngzgtc2cpauhfeel7eue8e4a19ta1fc8pdwrs6969b0b0kwecepfaktfc7y9jfc'],
  "Corbel": ['5k7ca2i7e9mdil5g8c8ceye97c997c7neacge7cleddcekbwebek7c7fe9e9e9bus3hnghgdinfbe0ikij6uafgtehmujckafukjggfcffingvoig8gig98r7n8re9dk9idmewc6ewdu8ueres6g6pdj6gn1eneterej9bb89neecujscndbcc8c6b8ce9cbdkn26363azazm0e9e9fakte97cbce9', '5q84azihenmzj85u8i8ieoen8t998486ebdrdvdkeodlfadkfgfb848tenenenchsgi9hbg8j5fsehioje7ob6hkeymyk8kegpl4hgg1fujghqpahohmgp8r868rendkavebfhc9fie994fafk6x7bec70nofffefafa9qbsajf5dnktehead08h6l8hencbdkn26r6rcncnodenenfakten84bcen'],
  "Consolas": ['fafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaktfafafafa', 'fafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaktfafafafa'],
};

const INDEX = new Map<string, number>([...CHARS].map((ch, i) => [ch, i]));
const decoded = new Map<string, [number[], number[]]>();

function decode(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 36));
  return out;
}

function widths(font: string): { table: [number[], number[]]; scale: number } {
  const known = TABLE[font] ? font : 'Segoe UI';
  let t = decoded.get(known);
  if (!t) {
    const raw = TABLE[known]!;
    t = [decode(raw[0]), decode(raw[1])];
    decoded.set(known, t);
  }
  return { table: t, scale: known === font ? 1 : 1.05 };
}

/** Fonts whose metrics are known. */
export const MEASURED_FONTS: readonly string[] = Object.keys(TABLE);

/** The width of `text` in points, set in `font` at `size` points. */
export function textWidth(text: string, font: string, size: number, bold = false): number {
  const { table, scale } = widths(font);
  const row = bold ? table[1] : table[0];
  const avg = row[INDEX.get('n')!]!;
  let units = 0;
  for (const ch of text) {
    const i = INDEX.get(ch);
    if (i !== undefined) units += row[i]!;
    else {
      const code = ch.codePointAt(0) ?? 0;
      // Wide scripts (CJK, Hangul, fullwidth forms) and emoji take a full em.
      units += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60) || code >= 0x1f300) ? 1000 : avg;
    }
  }
  return (units / 1000) * size * scale;
}
