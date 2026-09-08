# Payroll Atlas

A one-stop hub for payroll and HR professionals across Europe to track statutory and legislative changes, country by country — sourced only from government tax authorities, labour inspectorates, and social security bodies. Scope is Europe only for now — no plans to expand beyond it.

**Live site:** https://claude.ai/code/artifact/d08bdf72-35ed-4d3f-a385-68824e8535ef

## Product direction: subscription for employers & payroll providers

The site is being built toward a paid subscription for employers and payroll providers/EORs who need to track what's changing across their countries. Built so far (all in `payroll-atlas.html`):

- **`#changelog`** — a filterable feed of every item-card across all 29 countries (country / Payroll vs. Statutory Reporting / In force vs. Upcoming), driven by a hand-maintained `CHANGES` array in the `<script>` block. **This array must be updated by hand whenever a country page's item-cards change** — it does not read the DOM automatically.
- **`#pricing`** — three illustrative tiers (Starter free / Team €79mo / Provider €349mo). Prices, limits, and copy are placeholders for the user to review before this goes live — not validated against real market research.
- Email/Slack signup forms (on both `#changelog` and `#pricing`) — **UI only, not wired to a backend.** Submitting just shows a client-side success message; no email is actually captured or stored anywhere. Deliberately not using the Artifact tool's `db` capability, because declaring it would restrict the *entire* site to signed-in members of the owner's Claude.ai organization only — incompatible with a public marketing site. Before launch, wire these forms to a real service (Google Form, Mailchimp, ConvertKit, Formspree, or similar).

Also done: a "bold brand identity" visual redesign (vivid indigo/coral/emerald/amber/teal/violet palette replacing an earlier cream/terracotta pass), reusing the site's existing CSS custom-property token system so all 29 country pages inherited the new palette from one edit.

## Status

| Country | Status |
|---|---|
| 🇳🇴 Norway | Live |
| 🇫🇮 Finland | Live |
| 🇸🇪 Sweden | Live |
| 🇩🇰 Denmark | Live |
| 🇨🇿 Czech Republic | Live |
| 🇬🇧 United Kingdom | Live |
| 🇧🇪 Belgium | Live |
| 🇩🇪 Germany | Live |
| 🇬🇷 Greece | Live |
| 🇮🇪 Ireland | Live |
| 🇳🇱 Netherlands | Live |
| 🇦🇹 Austria | Live |
| 🇭🇺 Hungary | Live |
| 🇫🇷 France | Live |
| 🇪🇸 Spain | Live |
| 🇵🇹 Portugal | Live |
| 🇵🇱 Poland | Live |
| 🇱🇹 Lithuania | Live |
| 🇪🇪 Estonia | Live |
| 🇮🇹 Italy | Live |
| 🇸🇰 Slovakia | Live |
| 🇸🇮 Slovenia | Live |
| 🇭🇷 Croatia | Live |
| 🇷🇴 Romania | Live |
| 🇧🇬 Bulgaria | Live |
| 🇱🇻 Latvia | Live |
| 🇨🇾 Cyprus | Live |
| 🇲🇹 Malta | Live |
| 🇱🇺 Luxembourg | Live |

No country is currently in the research queue — suggest one any time.

## Files in this folder

- `payroll-atlas.html` — full source of the published site (landing page + all live country pages). Republish this file via the Artifact tool to update the live link above.

## How the site is organized

One HTML file with client-side hash routing:
- `#` — landing page (a dropdown selects the country, plus methodology)
- `#norway`, `#no-*` — Norway country page and its sections
- `#finland`, `#fi-*` — Finland country page and its sections
- `#sweden`, `#se-*` — Sweden country page and its sections
- `#denmark`, `#dk-*` — Denmark country page and its sections
- `#czechia`, `#cz-*` — Czech Republic country page and its sections
- `#uk`, `#uk-*` — United Kingdom country page and its sections
- `#belgium`, `#be-*` — Belgium country page and its sections
- `#germany`, `#de-*` — Germany country page and its sections
- `#greece`, `#gr-*` — Greece country page and its sections
- `#ireland`, `#ie-*` — Ireland country page and its sections
- `#netherlands`, `#nl-*` — Netherlands country page and its sections
- `#austria`, `#at-*` — Austria country page and its sections
- `#hungary`, `#hu-*` — Hungary country page and its sections
- `#france`, `#fr-*` — France country page and its sections
- `#spain`, `#es-*` — Spain country page and its sections
- `#portugal`, `#pt-*` — Portugal country page and its sections
- `#poland`, `#pl-*` — Poland country page and its sections
- `#lithuania`, `#lt-*` — Lithuania country page and its sections
- `#estonia`, `#ee-*` — Estonia country page and its sections
- `#italy`, `#it-*` — Italy country page and its sections
- `#slovakia`, `#sk-*` — Slovakia country page and its sections
- `#slovenia`, `#si-*` — Slovenia country page and its sections
- `#croatia`, `#hr-*` — Croatia country page and its sections
- `#romania`, `#ro-*` — Romania country page and its sections
- `#bulgaria`, `#bg-*` — Bulgaria country page and its sections
- `#latvia`, `#lv-*` — Latvia country page and its sections
- `#cyprus`, `#cy-*` — Cyprus country page and its sections
- `#malta`, `#mt-*` — Malta country page and its sections
- `#luxembourg`, `#lu-*` — Luxembourg country page and its sections

Each country page separates changes into two top-level categories, and each of those into two subsections:
1. **Payroll** — tax, employer contributions, employment law, benefits
   - **In force** — confirmed, dated changes
   - **Upcoming** — proposals/consultations not yet in force (only rendered when a country has one)
2. **Statutory Reporting** — administrative/filing obligations (e.g. Norway's A-melding API deadline, Finland's Incomes Register pay-gap report, Sweden's AGI form changes, Denmark's eIndkomst reporting rules, the Czech Republic's JMHZ single monthly employer report, the UK's mandatory payrolling of benefits in kind)
   - **In force** — confirmed reporting changes
   - **Upcoming** — including each country's EU Pay Transparency Directive status, and the UK's own ethnicity/disability pay gap reporting commitment (UK is not bound by the EU directive post-Brexit, but has a directly analogous reporting expansion in progress)

Every item card still carries its own "For the employer" / "For the employee" (or "Likely employer/employee action") split.

Countries are chosen via a `<select>` dropdown (in the header, and again on the landing page) rather than cards — this was a deliberate simplification so adding a new country doesn't require assigning it a distinct accent color or building a new card layout. All country pages share one neutral visual scheme.

## Primary sources tracked

**Norway**
- [Skatteetaten — Forskuddsutskrivingen 2026](https://www.skatteetaten.no/en/rettskilder/type/uttalelser/uttalelser/forskuddsutskrivingen-2026/)
- [Skatteetaten — Arbeidsgiveravgift 2026](https://www.skatteetaten.no/rettskilder/type/skattedirektoratets-meldinger/arbeidsgiveravgift-til-folketrygden-for-2026/)
- [NAV — Regulering av grunnbeløpet 2026](https://www.nav.no/regulering-2026)
- [NAV — Sykepenger](https://www.nav.no/sykepenger)
- [Arbeidstilsynet — Psychosocial work environment, 2026](https://www.arbeidstilsynet.no/nyheter/kravene-til-det-psykososiale-arbeidsmiljoet-blir-tydeligere-fra-arsskiftet/)
- [Arbeidstilsynet — Arbeidsmiljøloven](https://www.arbeidstilsynet.no/regelverk/lover/arbeidsmiljoloven--aml/)
- [Regjeringen.no — Likelønnsdirektivet](https://www.regjeringen.no/no/tema/likestilling-og-mangfold/likestilling-og-inkludering/om-likelonnsdirektivet/id3140297/)
- [Regjeringen.no — Høring: rett til heltid](https://www.regjeringen.no/no/dokumenter/horing-forslag-til-endringer-i-arbeidsmiljoloven-styrking-av-retten-til-heltid/id2895719/)
- [Revisorforeningen — Rapporteringsendringer (A-meldingen API)](https://www.revisorforeningen.no/fag/nyheter/viktige-endringer-i-rapportering-for-inntektsaret-2025/)

**Finland**
- [Vero.fi — Muutokset veroperusteisiin 2026](https://www.vero.fi/tietoa-verohallinnosta/tilastot/verotulojen-kehitys/muutokset-veroperusteisiin-verovuosittain/2026/)
- [Varma — Sosiaalivakuutusmaksut 2026](https://www.varma.fi/globalassets/tyonantaja/sosiaalivakuutusmaksut-ja-rajamaarat.pdf)
- [Kela — Tuet vuonna 2026](https://www.kela.fi/ajankohtaista/nain-kelan-tuet-muuttuvat-vuonna-2026-1)
- [TEM — Päätös TEM/2026/4](https://tem.fi/paatos?decisionId=5544)
- [Valtioneuvosto — Palkka-avoimuusdirektiivi](https://valtioneuvosto.fi/-/1271139/hallitus-esittaa-lakimuutoksia-palkkauksen-lapinakyvyyden-vahvistamiseksi)
- [Tulorekisteri 2026 — reporting guidance](https://ek-tieto.fi/tulorekisteri-2026-uusimmat-ohjeet-ja-kaytannon-vinkit-palkanlaskentaan/)

**Sweden**
- [Skatteverket — Belopp och procent 2026](https://www.skatteverket.se/privat/skatter/beloppochprocent/2026.4.1522bf3f19aea8075ba21.html)
- [Skatteverket — Arbetsgivaravgifter](https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/arbetsgivaravgifter.4.233f91f71260075abe8800020817.html)
- [Försäkringskassan — Aktuella belopp](https://www.forsakringskassan.se/privatperson/e-tjanster-blanketter-och-informationsmaterial/aktuella-belopp)
- [Arbetsmiljöverket — Föreskrifter](https://www.av.se/arbetsmiljoarbete-och-inspektioner/publikationer/foreskrifter/)
- [Regeringen.se — Lönetransparensdirektivet](https://www.regeringen.se/rattsliga-dokument/lagradsremiss/2026/01/genomforande-av-lonetransparensdirektivet/)
- [Grant Thornton Sweden — Nyheter för arbetsgivare 2026 (AGI changes)](https://www.grantthornton.se/insikt/tipsochrad/redo-2026-nyheter-att-ha-koll-pa-som-arbetsgivare/)

**Denmark**
- [Skatteministeriet — Faktaark: Topskat 2026](https://skm.dk/media/b1unl0if/faktaark-8-topskat.pdf)
- [Beskæftigelsesministeriet — ATP-satser 2026](https://bm.dk/satser/satser-for-2026/bidrag-til-arbejdsmarkedets-tillaegspension)
- [Lund Elmer Sandager — Barselsregler 2026](https://les.dk/da/news/nye-barselsregler-styrker-vilkaarene-selvstaendige-fra-2026)
- [Ferieloven — 5. ferieuge](https://ferieplanen.dk/ferieloven)
- [PwC Denmark — Løngennemsigtighed](https://www.pwc.dk/da/services/workforce/viden/lovforslag-om-aendring-af-ligelon.html)
- [Skattestyrelsen — eIndkomst indberetning](https://skat.dk/hjaelp/blanketter/03-skat-indberetninger/eindkomst-indberetning)

**Czech Republic**
- [Finanční správa — Daňové novinky 2026](https://financnisprava.gov.cz/cs/financni-sprava/media-a-verejnost/tiskove-zpravy-gfr/tiskove-zpravy-2026/danove-novinky-pro-rok-2026)
- [MPSV / mzdy.cz — Sazby sociálního a zdravotního pojištění 2026](https://mzdy.cz/sazby-odvodu)
- [MPSV — Minimální mzda](https://mpsv.gov.cz/minimalni-mzda)
- [ČSSZ — Údaje pro sociální zabezpečení 2026](https://www.cssz.gov.cz/-/prehled-nejdulezitejsich-udaju-pro-socialni-zabezpeceni-v-roce-2026)
- [EY Czech Republic — Transparentnost odměňování](https://www.ey.com/cs_cz/technical/tax/tax-alerts/2026/03/transparentnost-odmenovani-1-cast-novela-zakoniku-prace-zverejnena)
- [ČSSZ — JMHZ základní informace (Single Monthly Employer Report)](https://www.cssz.gov.cz/documents/20143/3188763/Jednotn%C3%A9+m%C4%9Bs%C3%AD%C4%8Dn%C3%AD+hl%C3%A1%C5%A1en%C3%AD+zam%C4%9Bstnavatele+(JMHZ)+%E2%80%93+Z%C3%A1kladn%C3%AD+informace.pdf)

**United Kingdom**
- [Deloitte Tax Scape — Frozen income tax and NI thresholds 2026/27](https://taxscape.deloitte.com/measures-autumn-budget-2025/key-income-tax-and-national-insurance-thresholds-to-remain-frozen.aspx)
- [Bishop Fleming — National Living Wage from April 2026](https://www.bishopfleming.co.uk/insights/what-national-living-wage-april-2026)
- [Pinsent Masons — Employment Rights Act implementation timeline](https://www.pinsentmasons.com/out-law/guides/employment-rights-bill-timeline-2026-beyond)
- [Acuity Law — Statutory sick and parental pay rates from April 2026](https://acuitylaw.com/updated-statutory-sick-pay-and-parental-pay-rates-from-april-2026/)
- [Davidson Morris — Employment Rights Act timeline](https://www.davidsonmorris.com/employment-rights-act-timeline/)
- [GOV.UK — Reporting of benefits in kind via RTI](https://www.gov.uk/government/publications/changes-to-reporting-of-benefits-in-kind-from-april-2027/mandatory-reporting-of-benefits-in-kind-in-real-time-information-rti-from-april-2027)
- [DLA Piper — Ethnicity and disability pay gap reporting confirmed](https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2026/ethnicity-and-disability-pay-gap-reporting-mandatory)

**Belgium**
- [Wolters Kluwer — Fiscale grensbedragen aanslagjaar 2027 (inkomsten 2026)](https://www.wolterskluwer.com/nl-be/expert-insights/fiscal-border-amounts)
- [RSZ — Administratieve instructies: socialezekerheidsbijdragen](https://www.socialsecurity.be/employer/instructions/dmfa/nl/latest/instructions/socialsecuritycontributions/contributions.html)
- [Securex — The GMMI will increase on 1 April 2026](https://www.securex.be/en/lex4you/employer/news/the-gmmi-will-increase-on-1-april-2026)
- [RSZ — DmfA, de multifunctionele aangifte](https://www.socialsecurity.be/site_nl/employer/applics/dmfa/index.htm)
- [UNIZO — Nieuwe tool voor loon- en arbeidstijdgegevens](https://www.unizo.be/berichten/nieuws/informatiebrieven-rsz)
- [VBO FEB — FAQ omzetting loontransparantierichtlijn uitgesteld](https://www.vbo-feb.be/nl/nieuws/faq-omzetting-loontransparantierichtlijn-uitgesteld-wat-nu/)

**Germany**
- [Bundesfinanzministerium — Die wichtigsten steuerlichen Änderungen 2026](https://www.bundesfinanzministerium.de/Content/DE/Standardartikel/Themen/Steuern/das-aendert-sich-2026.html)
- [AOK — Sozialversicherungsbeiträge, Rechengrößen 2026](https://www.aok.de/fk/jahreswechsel/sv-beitraege-2026/)
- [Bundesregierung — Mindestlohn steigt](https://www.bundesregierung.de/breg-de/aktuelles/mindestlohn-steigt-2391010)
- [AOK — Änderungen 2026: DEÜV und weitere Meldeverfahren](https://www.aok.de/fk/jahreswechsel/neues-im-elektronischen-meldeverfahren/aenderungen-2026-deuev-weitere-meldeverfahren/)
- [Lohnakademie — eAU ab 2027](https://www.lohnakad.de/2026/08/13/eau-ab-2027-das-aendert-sich-fuer-arbeitgeber-beim-elektronischen-abruf-der-arbeitsunfaehigkeitsdaten/)
- [Haufe — Umsetzung der Entgelttransparenzrichtlinie verzögert sich](https://www.haufe.de/personal/arbeitsrecht/eu-richtlinie-fuer-mehr-lohngleichheit_76_538404.html)

**Greece**
- [Taxheaven — Οι νέες αναλυτικές κλίμακες φορολογίας 2026](https://www.taxheaven.gr/news/71602/oi-nees-analytikes-klimakes-forologias-2026-sygkrish-2025-2026)
- [e-ΕΦΚΑ — Εγκύκλιος 4/2026, αναπροσαρμογή πλαφόν](https://www.taxheaven.gr/circulars/51989/egkyklios-e-efka-4-2026)
- [Υπουργείο Εργασίας — Αύξηση Κατώτατου Μισθού 2026 (official PDF)](https://ypergasias.gov.gr/wp-content/uploads/2026/03/%CE%A5%CE%A0%CE%95%CE%9A%CE%91-%CE%A0%CE%B1%CF%81%CE%BF%CF%85%CF%83%CE%AF%CE%B1%CF%83%CE%B7-%CE%9A%CE%B1%CF%84%CF%8E%CF%84%CE%B1%CF%84%CE%BF%CF%82-%CE%9C%CE%B9%CF%83%CE%B8%CF%8C%CF%82-%CE%9C%CE%AC%CF%81%CF%84%CE%B9%CE%BF%CF%82-2026.pdf)
- [Ergasiaka — Μισθολογική διαφάνεια: Ν. 5316/2026](https://www.ergasiaka-gr.net/2026/07/misthologiki-diafaneia-n5316-2026/)
- [Taxheaven — Ψηφιακή κάρτα εργασίας, ένταξη από 29 Ιουνίου 2026](https://www.taxheaven.gr/news/73985/pshfiakh-karta-ergasias-nea-apofash-me-kad-gia-entaxh-apo-29-ioynioy-2026)

**Ireland**
- [Grant Thornton Ireland — Budget 2026 payroll summary](https://www.grantthornton.ie/insights/budget/payroll-summary/)
- [DETE — National Minimum Wage increase](https://www.gov.ie/en/department-of-enterprise-tourism-and-employment/publications/national-minimum-wage-increase-on-1-january-2025/)
- [DSP — Statutory Sick Leave](https://www.gov.ie/en/department-of-social-protection/publications/illness-benefit-injury-benefit-and-statutory-sick-leave-in-2025/)
- [BDO — ERR compliance checks](https://www.bdo.global/en-gb/insights/tax/expatriate-tax/ireland-revenue-intensifies-compliance-checks-on-enhanced-reporting-requirements)
- [RTÉ — Gender Pay Gap Portal](https://www.rte.ie/news/business/2026/0618/1579146-gender-pay-gap-portal/)

**Netherlands**
- [Belastingdienst — Handboek Loonheffingen](https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/themaoverstijgend/brochures_en_publicaties/handboek-loonheffingen)
- [UWV — Premies en bedragen 2026](https://www.uwv.nl/nl/premies-bedragen)
- [Rijksoverheid — Bedragen minimumloon 2026](https://www.rijksoverheid.nl/themas/werk/minimumloon/bedragen-minimumloon/bedragen-minimumloon-2026)
- [PFZW — UPA-gegevens handleiding 2026](https://www.pfzw.nl/content/dam/pfzw/web/werkgevers/pensioenaangifte/2026_Handleiding-aanlevering-UPA-gegevens.pdf)
- [Eerste Kamer — Wetsvoorstel loontransparantie (36.949)](https://www.eerstekamer.nl/wetsvoorstel/36949_wet_implementatie_richtlijn)

**Austria**
- [EY Austria — Inflationsanpassungsverordnung 2026](https://www.ey.com/de_at/technical/steuernachrichten/inflationsanpassungsverordnung-2026)
- [WKO — Werte in der Sozialversicherung 2026](https://www.wko.at/sozialversicherung/voraussichtliche-werte-in-der-sozialversicherung-2026)
- [WKO — Kollektivvertrag Gewerbe, Handwerk und Dienstleistung 2026](https://www.wko.at/kollektivvertrag/kollektivvertrag-gewerbe-handwerk-und-dienstleistung-2026)
- [Remm Steuerberatung — ELDA Arbeitszeitmeldung ab 1.1.2026](https://www.remm-steuerberatung.at/news/angabe-der-arbeitszeit-bei-anmeldung-zur-sozialversicherung-ab-01-01-26-verpflichtend)
- [WKO — EU-Entgelttransparenzrichtlinie](https://www.wko.at/sbg/news/eu-entgelttransparenzrichtlinie--was-auf-arbeitgeber-zukommt)

**Hungary**
- [NAV — Szja adóalap-kedvezmények 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F73.-Szja-adoalap-kedvezmenyek-2026.-01.-16)
- [Pénzcentrum — Szociális hozzájárulási adó 2026-ban](https://www.penzcentrum.hu/karrier/20260125/szocialis-hozzajarulasi-ado-2026-ban-az-ado-alapja-merteke-befizetesenek-modja-a-nav-fele-1192276)
- [BDO Hungary — Minimálbér és garantált bérminimum 2026](https://www.bdo.hu/hu-hu/aktualitasok-blog/blog/minimalber-es-garantalt-berminimum-2026-minden-fontos-tudnivalo-egy-helyen)
- [Adóvilág — A 2608 jelű járulékbevallás változásai 2026](https://adovilag.hu/2026/01/05/a-2608-jelu-jarulekbevallas-valtozasai-es-ujdonsagai-az-elozo-evhez-kepest/)
- [Deloitte Hungary — EU Bértranszparencia irányelv](https://www.deloitte.com/hu/hu/services/consulting/perspectives/EU-bertranszparencia-iranyelv-kozeledo-hataridok-es-felkeszulesi-feladatok.html)

**France**
- [LégiFiscal — Barème IR 2026](https://www.legifiscal.fr/actualites-fiscales/4390-ir-2026-bareme-revalorise-11-assemblee-nationale.html)
- [LégiSocial — Taux de cotisations sociales URSSAF 2026](https://www.legisocial.fr/reperes-sociaux/taux-cotisations-sociales-urssaf-2026.html)
- [info.gouv.fr — Le SMIC revalorisé le 1er juin 2026](https://www.info.gouv.fr/actualite/le-smic-revalorise-le-1er-juin-2026)
- [Nexus Paies Conseils — DSN 2026, ce qui change](https://www.nexuspaiesconseils.fr/actualites/dsn-2026-ce-qui-change/)
- [Le Journal des Entreprises — Transparence salariale, pas avant le printemps 2027](https://www.lejournaldesentreprises.com/article/transparence-salariale-pas-de-transposition-de-la-directive-europeenne-avant-le-printemps-2027-2145755)

**Spain**
- [Wolters Kluwer — Tramos y retenciones IRPF 2026](https://www.wolterskluwer.com/es-es/expert-insights/tramos-retenciones-irpf-2026-novedades)
- [Wolters Kluwer — Bases de cotización 2026](https://www.wolterskluwer.com/es-es/expert-insights/bases-cotizacion-2026)
- [El Derecho — Real Decreto, SMI 2026](https://elderecho.com/real-decreto-por-el-que-se-fija-el-salario-minimo-interprofesional-para-2026/)
- [Billeo — Sistema RED Seguridad Social 2026](https://www.billeo.es/blog/sistema-red-seguridad-social-online-2026)
- [Bird & Bird — Cuenta atrás para la trasposición de la Directiva](https://www.twobirds.com/es/insights/2026/spain/transparencia-retributiva)

**Portugal**
- [Orçamento do Estado — Tabelas de retenção IRS 2026](https://www.oe.gov.pt/noticias/publicadas-as-tabelas-de-retencao-na-fonte-do-irs-para-2026/)
- [PwC Portugal — Segurança Social 2026](https://www.pwc.pt/pt/pwcinforfisco/guia-fiscal/2026/seguranca-social.html)
- [DECO PROteste — Salário mínimo 2026](https://www.deco.proteste.pt/dinheiro/emprego/noticias/salario-minimo-2026-passa-920-euros)
- [Littler Portugal — Novo modelo de comunicação com a Segurança Social](https://www.littler.pt/novo-modelo-comunicacao-seguranca-social/)
- [Crowe Portugal — Transparência salarial](https://www.crowe.com/pt/insights/transparencia-salarial-2026)

**Poland**
- [Podatnik.info — Skala podatkowa 2026](https://www.podatnik.info/publikacje/skala-podatkowa-2026-progi-podatkowe-kwota-wolna-i-zasady-rozliczenia,6702ef)
- [rp.pl — Płaca minimalna i składki ZUS 2026](https://pro.rp.pl/zus/art43548741-nowe-prawo-2026-biznes-mierzy-sie-z-podwyzka-placy-minimalnej-i-skladek-na-ubezpieczenia-spoleczne)
- [enova.pl — PPK 2026](https://enova.pl/blog/zmiany-w-ppk-w-2026-roku-i-autozapis-do-ppk-co-trzeba-wiedziec/)
- [SD Worx — Jawność wynagrodzeń dopiero od 2027 roku](https://www.sdworx.pl/pl-pl/blog/place-benefity/jawnosc-wynagrodzen-dopiero-od-2027-roku-nowy-projekt-ustawy)

**Lithuania**
- [VMI — GPM pakeitimai nuo 2026 m.](https://www.vmi.lt/evmi/gyventoju-pajamu-mokescio-pakeitimai-nuo-2026-m.)
- [Sodra — Įmokų tarifai 2026](https://sodra.lt/nuo-2026-m-sausio-1-d-taikomi-sodros-imoku-tarifai-turintiems-samdomu-darbuotoju?lang=en)
- [Grynai.lt — Minimali alga 2026](https://grynai.lt/minimali-alga/)
- [Sorainen — Skaidrumo direktyvos įgyvendinimas Lietuvoje](https://www.sorainen.com/lt/publikacijos/es-darbo-u-mokes-io-skaidrumo-direktyvos-gyvendinimas-lietuvoje-pagrindiniai-reikalavimai-darbdaviams-2/)
- [Kiznė Legal — Pranešimas Sodrai nuo 2027 m.](https://kizne.legal/2026/07/09/skaidraus-darbo-uzmokescio-pranesimas-sodrai/)

**Estonia**
- [Rahandusministeerium — Maksuküür kaob 2026](https://www.fin.ee/uudised/maksukuur-kaob-2026-aastal)
- [EMTA — Maksumuudatused 2026](https://www.emta.ee/uudised/maksumuudatused-2026)
- [MKM — Töötasu alammäär 2026](https://www.mkm.ee/uudised/tootasu-alammaar-touseb-aprillist-946-euroni)
- [Raamatupidaja.ee — TSD süsteemi muudatus](https://www.raamatupidaja.ee/uudised/2025/01/20/mta-plaanib-raamatupidamiskirjendite-pohise-tsd-kasutuselevottu-2026-aasta-lopus)
- [MKM — Palkade läbipaistvuse direktiiv](https://mkm.ee/uudised/kkk-euroopa-liidu-palkade-labipaistvuse-direktiiv-ja-selle-rakendamine-eestis)

**Italy**
- [Scaglioni IRPEF 2026 — Legge di Bilancio 2026 (L. 199/2025)](https://www.soluzionetasse.com/scaglioni-irpef/)
- [Fiscomania — Contributi INPS 2026](https://fiscomania.com/calcolo-contributi-versati/)
- [Dottrina Lavoro — INAIL rivalutazione minimale e massimale dal 1 luglio 2026](https://www.dottrinalavoro.it/notizie-c/inail-rivalutazione-minimale-e-massimale-di-rendita-dal-1-luglio-2026)
- [Altalex — D.Lgs. 96/2026 trasparenza retributiva](https://www.altalex.com/documents/2026/06/05/trasparenza-retributiva-d-lgs-96-2026-attua-direttiva-ue-2023-970)

**Slovakia**
- [Podnikajte.sk — Progresívne zdanenie príjmov fyzických osôb od roku 2026](https://www.podnikajte.sk/dan-z-prijmov/progresivne-zdanenie-prijmov-fyzickych-osob-od-2026)
- [Kryptomagazín — Odvody zamestnanca a zamestnávateľa v roku 2026](https://kryptomagazin.sk/odvody-zamestnanca-a-zamestnavatela-v-roku-2026/)
- [MPSVR SR — Historický nárast minimálnej mzdy 2026](https://www.employment.gov.sk/sk/uvodna-stranka/informacie-media/aktuality/historicky-narast-minimalnej-mzdy-je-realitou-roku-2026-je-minimalna-mzda-vo-vyske-915-eur.html)
- [eSudca.sk — Transparentné odmeňovanie 2026](https://www.esudca.sk/blog/transparentne-odmenovanie-2026)

**Slovenia**
- [Minimax — Dohodninska lestvica 2026](https://www.minimax.si/sl-si/dohodninska-lestvica-2026-kaj-se-spreminja)
- [24ur.com — Minimalna plača v letu 2026 za 16 odstotkov višja](https://www.24ur.com/novice/slovenija/minimalna-placa-v-letu-2026-za-16-odstotkov-visja.html)
- [Forbes Slovenija — Kako daleč je priprava zakona o preglednosti plač](https://forbes.n1info.si/novice/kako-dalec-je-priprava-zakona-ki-prinasa-nova-pravila-pri-placah/)

**Croatia**
- [Porezna uprava — Stope godišnjeg poreza na dohodak za 2026. godinu](https://porezna-uprava.gov.hr/hr/stope-godisnjeg-poreza-na-dohodak-za-2026-godinu/8166)
- [Vlada Republike Hrvatske — Minimalna bruto plaća za iduću godinu 1.050 eura](https://vlada.gov.hr/minimalna-bruto-placa-za-iducu-godinu-1-050-eura-uz-kompenzacijske-mjere-za-poslodavce/45248)
- [Porezna uprava — Ažuriranje JOPPD obrasca u sustavu ePorezna](https://porezna-uprava.gov.hr/hr/azuriranje-joppd-obrasca-u-sustavu-eporezna/8249)
- [IUS-INFO — Direktiva o transparentnosti plaća](https://www.iusinfo.hr/aktualno/u-sredistu/direktiva-o-transparentnosti-placa-koje-promjene-donosi-za-poslodavce-i-radnike-68252)

**Romania**
- [Up Romania — Contribuții salariu 2026: CAS, CASS, impozit pe venit](https://upromania.ro/media/blog/contributii-salariu-cas-cass-impozit-pe-venit/)
- [Termene.ro — Majorarea salariului minim în 2026 la 4.325 de lei](https://termene.ro/articole/majorarea-salariului-minim-la-in-2026-statul-ia-156-de-lei-din-majorarea-de-275-de-lei-impactul-real-pentru-firme-si-angajati)
- [Lugera — Declarația 112 2026: ce trebuie să știe angajatorii](https://www.lugera.ro/blog/declaratia-112-2026-noul-formular-aduce-modificari-pentru-salariul-minim-netaxabil-si-concediile-medicale/)
- [Deloitte Romania — Directiva UE privind transparența salarială](https://www.deloitte.com/ro/ro/our-thinking/articles/directiva-ue-privind-transparenta-salariala-de-cand-produce-efecte-si-ce-informatii-pune-la-dispozitia-angajatilor.html)

**Bulgaria**
- [NAP — Осигурителен доход и вноски за 2026 г.](https://www.nap.bg/news?id=5824)
- [Министерство на труда и социалната политика — Минимална работна заплата за 2026 г.](https://www.mlsp.government.bg/minimalna-rabotna-zaplata-2026)
- [Eversheds Sutherland — EU Pay Transparency Directive implementation tracker](https://www.eversheds-sutherland.com/en/global/insights/pay-transparency-directive-implementation-tracker)

**Latvia**
- [VID — Iedzīvotāju ienākuma nodoklis 2026](https://www.vid.gov.lv/lv/iedzivotaju-ienakuma-nodoklis)
- [Labklājības ministrija — Minimālās algas apmērs 2026. gadā](https://www.lm.gov.lv/lv/mineimalas-algas-apmers-2026-gada)
- [Eversheds Sutherland — EU Pay Transparency Directive implementation tracker](https://www.eversheds-sutherland.com/en/global/insights/pay-transparency-directive-implementation-tracker)

**Cyprus**
- [Cyprus Tax Department — Personal income tax rates](https://www.mof.gov.cy/mof/tax/taxdep.nsf/index_en/index_en)
- [Ministry of Labour and Social Insurance — National minimum wage](https://www.mlsi.gov.cy/mlsi/dl/dl.nsf/All/minimum-wage)
- [Eversheds Sutherland — EU Pay Transparency Directive implementation tracker](https://www.eversheds-sutherland.com/en/global/insights/pay-transparency-directive-implementation-tracker) *(status flagged as unconfirmed — verify directly before relying on it)*

**Malta**
- [Commissioner for Revenue — Individual tax rates 2026](https://cfr.gov.mt/en/individuals/Pages/Tax-Rates-2026.aspx)
- [Government of Malta — Cost of Living Adjustment for 2026 announced](https://www.gov.mt/en/Government/DOI/Press%20Releases/Pages/2025/October/13/pr252189.aspx)
- [Government of Malta — Equal Pay for Equal Work amendments 2026](https://www.gov.mt/en/Government/Press%20Releases/Pages/2026.aspx)

**Luxembourg**
- [Gouvernement du Luxembourg — Tranche indiciaire 2026](https://gouvernement.lu/en/actualites/toutes_actualites/communiques/2026/index.html)
- [Inspection du Travail et des Mines — Salaire social minimum](https://itm.public.lu/fr/legislation/droit-travail/remuneration/salaire-social-minimum.html)
- [Eversheds Sutherland — EU Pay Transparency Directive implementation tracker](https://www.eversheds-sutherland.com/en/global/insights/pay-transparency-directive-implementation-tracker)

## Monthly sweep merge log

**8 September 2026 — first monthly cloud sweep merged.** The scheduled routine (`trig_01WwQcGjDKvMefQ2hMdQiBzi`) found ~70 items across 27 of 29 countries (Norway and Denmark had nothing new). Rather than adding every item, the merge prioritized corrections and high-confidence, employer-actionable changes:

- **Real bug fixed**: the UK's benefits-in-kind item wrongly said mandatory payrolling started April 2026 — verified independently, actually phased from April 2027 (Phase 1: cars/fuel/vans/medical) then April 2028 (most others). Moved to the "upcoming" section and corrected.
- **Checked and confirmed already correct**: Netherlands minimum wage (€14.99, 1 Jul), France SMIC mid-year revaluation (+2.41%) — both already accurately on the site.
- **Checked and discarded as unverified**: Latvia's reported VSAOI 22.00%/12.09% split (independent search found no corroboration — 23.59%/10.50% still holds), and Belgium's reported third 2026 minimum-wage increase to ~€2,233.61 (unconfirmed by any source found).
- **New items added**: UK (AMAP mileage rate 55p), Poland (anti-mobbing law, PIP B2B reclassification power), Greece (pay-transparency employer-obligations date, Digital Work Card Phase B), Bulgaria (August social-security ceiling rise), Spain (TGSS notice-in-lieu contribution reversal), Malta (Conditions of Work Regulation Orders), Estonia (partial pay-transparency transposition — split from "upcoming" into "in force" + a narrower "upcoming" item), Luxembourg (second 2026 index tranche postponed to 2027).
- **Status refreshed**: Croatia, Romania, and Cyprus pay-transparency items updated with autumn-2026 vote timelines.
- **Not merged this round** (lower priority / more minor): Belgium wage-indexation cap & flexi-jobs expansion, Slovakia PD A1 e-filing date, 2027 minimum-wage previews for Czech Republic/Slovakia/Germany, several countries' smaller administrative-filing tweaks (Sweden, Ireland, Netherlands, Austria, Lithuania, Portugal, Italy, Croatia reporting details). These are in the full sweep report if picked up later.
- The `CHANGES` array and sidebar item counts were updated to match every change above.

**8 September 2026 — post-merge integrity audit.** After the merge above, a full structural check (div/section/brace balance, sidebar-count vs. actual-item-card counts, CHANGES-array section references vs. real HTML ids) turned up two real bugs, both now fixed and republished:

- **Broken HTML introduced by this session's Greece edit**: the second new item-card in `gr-reporting-upcoming` was accidentally left with orphaned markup from the item it replaced (a stray `<div class="actions">` block, a duplicate source link, and an extra closing `</div>`) — this would have rendered broken/duplicated content on Greece's page. Removed.
- **Pre-existing bug, unrelated to this session**: Germany's "Reporting & filing" sidebar badge said 2 items but the section only ever had 1. Corrected to 1.
- **Known gap, not fixed** (deliberately — no real source exists to cite): Norway's "Broader tax reform white paper expected" and Finland's "Budget 2027 tax and contribution rates" items have no source link, because both describe a document that hasn't been published yet. This is a narrow, defensible exception to the site's "every figure links to its source" rule, but worth knowing about if auditing again.
- Verified clean: all 29 `VIEW_IDS` entries match real views with no duplicates; all 153 `CHANGES` array `section:` references resolve to real HTML ids; no leftover pre-redesign color values; script brace/paren/bracket balance checks out.

## Last verified

8 September 2026 (annual/general), with the monthly sweep merge above current as of the same date

## Next up

No country currently queued. Plan is to keep adding European countries one at a time; no countries outside Europe are planned. Not yet covered: Portugal-adjacent microstates and remaining smaller EU/EEA states (e.g. Iceland, Liechtenstein), plus non-EU Europe (Switzerland, Serbia, Albania, North Macedonia, Bosnia, Montenegro, Moldova, Ukraine, and others) — suggest any of these to add next.
