import Experience from "@/components/Experience";
import { AT_A_GLANCE, CRISTO_FIGURES, TIMELINE } from "@/lib/content";

export default function Home() {
  return (
    <Experience>
      <main id="journey">
        <section data-shot="hero" className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title" className="hero-title">
              Bem-vindu ba
              <br />
              Timor-Leste
            </h1>
            <p className="hero-lede">
              Welcome to Timór Lorosa&apos;e, the land where the sun rises. Climb Cape Fatucama to Cristo Rei as
              dawn breaks over the Wetar Strait.
            </p>
          </div>
          <p className="hero-cue">Scroll to begin</p>
        </section>

        <section data-shot="name" className="chapter chapter--left" aria-labelledby="name-title">
          <div className="chapter-body">
            <h2 id="name-title">A name that means east, twice</h2>
            <p>
              <em>Timor</em> comes from <em>timur</em>, the Malay and Indonesian word for east. <em>Leste</em> is
              Portuguese for east. Put together, Timor-Leste translates as &ldquo;East East&rdquo;.
            </p>
            <p>
              In Tetun the country is <em>Timór Lorosa&apos;e</em>. <em>Lorosa&apos;e</em> also means east, but
              literally it says where the sun rises.
            </p>
            <dl className="names">
              <div>
                <dt>English</dt>
                <dd>Democratic Republic of Timor-Leste</dd>
              </div>
              <div>
                <dt>Portuguese</dt>
                <dd>República Democrática de Timor-Leste</dd>
              </div>
              <div>
                <dt>Tetun</dt>
                <dd>Repúblika Demokrátika Timór-Leste</dd>
              </div>
            </dl>
          </div>
        </section>

        <section data-shot="facts" className="chapter chapter--right" aria-labelledby="facts-title">
          <div className="chapter-body">
            <h2 id="facts-title">The country at a glance</h2>
            <p>
              Timor-Leste is the eastern half of the island of Timor, plus the Oecusse exclave in the northwest and
              the islands of Atauro and Jaco. Indonesia lies to the west; Australia is across the Timor Sea to the
              south.
            </p>
            <dl className="glance">
              {AT_A_GLANCE.map((item) => (
                <div key={item.term}>
                  <dt>{item.term}</dt>
                  <dd>{item.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section data-shot="history" className="chapter chapter--left chapter--long" aria-labelledby="history-title">
          <div className="chapter-body">
            <h2 id="history-title">From sandalwood to sovereignty</h2>
            <p>
              Centuries of trade, colonial rule, war and occupation came before independence. The story below follows
              the turning points.
            </p>
            <div className="timeline">
              <span className="timeline-rail" aria-hidden="true">
                <span className="timeline-rail-fill" />
              </span>
              <ol>
                {TIMELINE.map((event) => (
                  <li key={event.when}>
                    <h3>{event.when}</h3>
                    <p>{event.what}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section data-shot="land" className="chapter chapter--right" aria-labelledby="land-title">
          <div className="chapter-body">
            <h2 id="land-title">Mountains, reefs and three seas</h2>
            <p>
              The country is about 265 km long and 97 km wide, with around 700 km of coastline. The rougher Banda
              Sea, through the Ombai and Wetar Straits, lies to the north. The calmer Timor Sea lies to the south, and
              the Savu Sea lies north of Oecusse.
            </p>
            <p>
              The interior is a spine of inactive volcanic mountains; almost half the land has a slope of 40% or
              more. The coastal waters belong to the Coral Triangle, one of the richest marine regions on Earth. In
              the far east, Nino Konis Santana National Park protects the last tropical dry forest in the country.
            </p>
            <p>
              The climate is tropical. A wet season runs from December to May, and the mountains stay cooler than
              the coast.
            </p>
          </div>
        </section>

        <section data-shot="culture" className="chapter chapter--left" aria-labelledby="culture-title">
          <div className="chapter-body">
            <h2 id="culture-title">Sacred houses, tais and lulik</h2>
            <p>
              Community life is centred on the <em>uma lulik</em>, the sacred house that identifies each family
              group. <em>Lulik</em> means sacred, and the idea reaches beyond buildings to land, objects and
              ceremonies. Parliament itself is described as the national sacred house.
            </p>
            <p>
              <em>Tais</em> textiles are handwoven by women, and their patterns tell you which community they come
              from. Oral history is kept by the <em>lia nain</em>, who can recite long stories and poems, and poetry
              runs deep: Xanana Gusmão is known as the poet warrior.
            </p>
            <p>
              Alongside Tetun and Portuguese, up to 19 indigenous languages are spoken, from the Austronesian and
              Papuan families. In 2013 the country released its first feature film, <em>Beatriz&apos;s War</em>.
            </p>
          </div>
        </section>

        <section data-shot="cristo" className="chapter chapter--right chapter--long" aria-labelledby="cristo-title" id="cristo-rei">
          <div className="chapter-body">
            <h2 id="cristo-title">Cristo Rei of Dili</h2>
            <p className="chapter-lede">
              A 27-metre statue of Christ standing on a globe at the tip of Cape Fatucama, looking west across the
              Bay of Dili.
            </p>
            <ul className="figures">
              {CRISTO_FIGURES.map((f) => (
                <li key={f.label}>
                  <strong>{f.value}</strong>
                  <span>{f.label}</span>
                </li>
              ))}
            </ul>
            <p>
              The statue was designed by Mochamad Syailillah and unveiled on 15 October 1996 by President Suharto, a
              gift from the Indonesian government marking 20 years of its rule over the territory. About 30 workers in
              Bandung built the copper body over almost a year. Each section weighed 100 to 200 kg and was lifted up
              the 100-metre peak on a bamboo frame.
            </p>
            <p>
              Its numbers were political. The 27 metres stood for Indonesia&apos;s 27th province, and the 34 metres
              of statue and globe, twice 17, pointed to 17 July 1976 and 17 August 1945. Days before the unveiling,
              Bishop Carlos Filipe Ximenes Belo, who had just shared the Nobel Peace Prize with José Ramos-Horta,
              questioned it:
            </p>
            <blockquote>
              <p>
                &ldquo;What&apos;s the point of building a statue to Jesus if people are not going to be treated
                according to the gospel?&rdquo;
              </p>
              <cite>Bishop Carlos Filipe Ximenes Belo</cite>
            </blockquote>
            <p>
              After independence the statue was kept, and Xanana Gusmão, once a fierce critic, supported its
              renovation as prime minister. Today Timorese say it belongs
              to Timor-Leste. It is a symbol of Dili and of the Catholic faith, and one of the country&apos;s main
              sights. From its base you can look back across the bay to Dili, north to Atauro Island, and down to
              Jesus Backside Beach on the Wetar Strait.
            </p>
          </div>
        </section>

        <section data-shot="closing" className="closing" aria-labelledby="closing-title">
          <h2 id="closing-title">Bondia, Timor-Leste</h2>
          <p>
            Climb the 570 steps before dawn, watch the sun rise over the Wetar Strait, and say <em>bondia</em>, good
            morning, to the first person you meet.
          </p>
        </section>
      </main>

      <footer className="site-footer">
        <div className="tais-band" aria-hidden="true" />
        <div className="footer-inner">
          <p className="footer-love">
            Created with love by <span className="footer-name">Julião Martins</span>
          </p>
          <div className="footer-sources">
            <p>
              Text is summarised from the Wikipedia articles{" "}
              <a href="https://en.wikipedia.org/wiki/Timor-Leste">Timor-Leste</a> and{" "}
              <a href="https://en.wikipedia.org/wiki/Cristo_Rei_of_Dili">Cristo Rei of Dili</a>, licensed{" "}
              <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>.
            </p>
            <p>
              Dili&apos;s buildings, roads, lakes and coastline: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, ODbL.
              Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (SRTM and bathymetry) on AWS Open Data.
              The intro map follows the framing of the{" "}
              <a href="https://commons.wikimedia.org/wiki/File:East_Timor_map_mhn.jpg">East Timor map</a> by Mats Halldin.
            </p>
          </div>
        </div>
      </footer>
    </Experience>
  );
}
