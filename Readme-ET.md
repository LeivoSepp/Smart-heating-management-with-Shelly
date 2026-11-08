# Nutikas ja odav börsihinna järgi kütmine Shellyga 

> [!TIP]
> See Shelly skript tagab kütteseadme töö kõige odavamate tundide ajal, kasutades elektri börsihindu ja erinevaid algoritme.

> [!IMPORTANT]
> Alates 1. oktoobrist 2025 kasutab Elering 15-min elektrihinda, mis tähendab, et nende API struktuur on muutunud. Et sinu Shelly automatiseerimine töötaks edasi, pead:
> 
> ✅ Uuendama oma Shelly skripti
>
> * Minimaalne nõutud versioon: 4.8 või uuem
> * Põhjus: Vanemad skriptid eeldavad tunnipõhiseid hindu, kuid nüüd tagastab API 15-minutilisi intervalle.

> [!IMPORTANT]
> Alates 1. oktoobrist 2025 kasutab Elering 15-min elektrihinda, mis tähendab neli korda rohkem andmeid. Versiooni 4.9 mälutipp oli 22 kB, seega kehtis reegel üks skript seadme kohta. Versioon 5 loeb hinnad osadena ja tipp on madalam (Espruino mõõtmises 13–14 kB, Plus 1PM-il 14,8 kB); kontrolli oma seadmel ``mem_peak`` enne kahe eksemplari käivitamist.
> Seda ei ole veel Gen-4 seadmetega testitud — need võivad toetada suuremat skriptimälu.


- [Nutikas ja odav börsihinna järgi kütmine Shellyga](#nutikas-ja-odav-börsihinna-järgi-kütmine-shellyga)
  - [Põhifunktsioonid](#põhifunktsioonid)
  - [Jälgimine ja ajakava muutmine](#jälgimine-ja-ajakava-muutmine)
  - [Kuidas kontrollida ajakava](#kuidas-kontrollida-ajakava)
  - [Skripti parameetrite konfigureerimine](#skripti-parameetrite-konfigureerimine)
    - [Skripti Virtual Componentide häälestamine](#skripti-virtual-componentide-häälestamine)
    - [Kuidas panna skript tööle KVS-modes](#kuidas-panna-skript-tööle-kvs-modes)
    - [Skripti KVS häälestamine](#skripti-kvs-häälestamine)
      - [Heating parameters](#heating-parameters)
      - [``"EnergyProvider": "VORK1"``](#energyprovider-vork1)
      - [``"AlwaysOnPrice": 10``](#alwaysonprice-10)
      - [``"AlwaysOffPrice": 300``](#alwaysoffprice-300)
      - [``"MaxFullPrice": 0``](#maxfullprice-0)
      - [``"SlotMinutes": 60``](#slotminutes-60)
      - [``"InvertedRelay": false``](#invertedrelay-false)
      - [``"RelayId": 0``](#relayid-0)
      - [``"Country": "ee"``](#country-ee)
      - [``"HeatingCurve": 0``](#heatingcurve-0)
- [Kuidas seda skripti installida](#kuidas-seda-skripti-installida)
  - [Paigaldamine](#paigaldamine)
  - [Kuidas panna tööle kaks installatsiooni](#kuidas-panna-tööle-kaks-installatsiooni)
    - [Kuidas panna skript tööle KVS-modes](#kuidas-panna-skript-tööle-kvs-modes-1)
  - [Skripti uuendamine](#skripti-uuendamine)
  - [Kuidas kontrollida et skript töötab](#kuidas-kontrollida-et-skript-töötab)
  - [Kuidas skript töötab](#kuidas-skript-töötab)
  - [Oluline teada](#oluline-teada)
  - [Testitud rikkestsenaariumid](#testitud-rikkestsenaariumid)
- [Maasoojuspumpade Thermia Villa \& Eko Classic nutikas kütmine Shelly abil](#maasoojuspumpade-thermia-villa--eko-classic-nutikas-kütmine-shelly-abil)
- [Nutikad kütte algoritmid](#nutikad-kütte-algoritmid)
  - [Ilmaprognoosi algoritm](#ilmaprognoosi-algoritm)
    - [Ilmaprognoosipõhise kütmise eelised](#ilmaprognoosipõhise-kütmise-eelised)
    - [Shelly geograafiline asukoht](#shelly-geograafiline-asukoht)
    - [Küttegraafik](#küttegraafik)
  - [Ajaperioodi algoritm](#ajaperioodi-algoritm)
- [Kas see tõesti vähendab minu elektriarveid](#kas-see-tõesti-vähendab-minu-elektriarveid)
- [Tõrkeotsing](#tõrkeotsing)
  - [Viga "Couldn't get script"](#viga-couldnt-get-script)
  - [Advanced → Key Value Storage → Script Data](#advanced--key-value-storage--script-data)
- [Litsents](#litsents)
- [Autor](#autor)


## Põhifunktsioonid 
1. **Ilmaennustusega odavad tunnid**: Järgmise päeva küttetunnid on optimeeritud ilmaprognoosi ja energiahindade põhjal. 
2. **Fikseeritud odavad tunnid**: Jaota päev ajaperioodideks (6, 12 või 24) ja aktiveeri küte iga perioodi kõige odavama(te)l tundidel. 
3. **Hinnatasemete kasutamine**: Kasuta min ja max hinnaläve, et hoida Shelly süsteem sellest lähtuvalt ka sees või väljas. 

**Käivituse ajakava**: Skript töötab iga päev pärast 23:45 või vajadusel päeva jooksul, et arvutada järgmise perioodi või päeva küttetunnid. 

### Hinnaslotid ja versiooni 5 muudatused (``SlotMinutes``, ``MaxFullPrice``)
* Ilma ``SlotMinutes`` võtmeta planeerib skript tunni keskmise hinna järgi ja lülitab kord tunnis, nagu enne versiooni 5. Veerandtunnine lülitamine sobib akupaagile või boilerile; soojuspump või kompressor jäägu tunnirežiimi või kasutagu pikemaid slotte.
* Võtmega ``"SlotMinutes": 15`` planeerib ja lülitab skript kütet 15-minutiliste hindade järgi. ``HeatingTime`` ja ``TimePeriod`` on endiselt tundides: ``HeatingTime: 10`` tähendab perioodi 40 kõige odavamat veerandtundi. Teised sloti pikkused (30, 120, 180, 240) kasutavad sloti keskmist börsihinda ja keskmist võrgutasu ning ``HeatingTime`` ümardatakse tervete slottideni alla (``240`` vajab vähemalt 4 h; ümardamine kirjutatakse logisse). ``AlwaysOnPrice``, ``AlwaysOffPrice`` ja ``MaxFullPrice`` kehtivad iga sloti kohta.
* Skript loob kuni neli ajakava, üks iga tunniveerandi kohta (minut 0, 15, 30 ja 45). Relee lülitub välja ühe sloti ja 10 sekundi pärast, nii et järjestikused slotid hoiavad selle sees.
* Hinnad küsitakse Eleringist 6-tunniste osadena, et mälu tipp jääks väikseks. Arvutus käib päeva viimase tunni (või ``IsForecastUsed`` korral iga perioodi viimase tunni) minutitel 46 kuni 55, kui selle tunni viimane slott on juba alanud. ``TimePeriod`` 0 korral ilmaprognoosi ei kasutata, ka siis mitte, kui ``IsForecastUsed`` on true.
* KVS-i ``ExistingSchedule`` on ajakavade ID-de loend. Versiooni 4.9 üks ID teisendatakse automaatselt ja watchdog kustutab kõik loendis olevad ajakavad.
* Sügisese kellakeeramise ööl planeeritakse korduv kell 03 tund eraldi slottidena, aga ajakava käivitub ühe kellaaja kohta korra, nii et sel ööl köetakse kuni tund vähem kui plaanis. Tunnist pikemate slottide korral jääb kellakeeramise päeva poolik viimane slott planeerimata, et relee oleks keskööks väljas.
* Veerandtunnised slotid säästavad raha ainult siis, kui leping arveldab veerandtunni kaupa.

### Testide käivitamine
Testid käivitavad skripti Node.js 24-s, Shelly API-d on asendatud ja Eleringi ning Open-Meteo vastused on salvestatud. Väliseid pakette pole vaja:
```
npm test
```
``npm test`` võrdleb ajutiste andmete mahtu versiooniga 4.9. Mootori mälu mõõdetakse eraldi Espruino interpretaatoris, millel Shelly skriptimootor põhineb:
```
tests/espruino/build-espruino.sh
npm run test:memory
```
Ehitusskript kompileerib Espruino 2v29 (commit ``e73051a``) koos ``tests/espruino/espruino-shelly.patch`` muudatustega Dockeris staatiliseks 32-bitiseks binaariks, nii et muutujaplokk on 14 baiti nagu ESP32-l (``--native`` ehitab hosti kompilaatoriga, 64-bitisel masinal 18-baidised plokid). ``npm run test:memory`` jooksutab versiooni 4.9 ja praeguse skripti ühe arvutustsükli salvestatud tavalise, kahe suveaja vahetuse ja negatiivse hinnaga päeva peal nelja sättega (vaikimisi tunnirežiim, akupaak 15 min, soe vesi 15 min, terve päev 15 min), loeb ``process.memory()`` kaudu mälu tipu ja tsükli järel alles jäänud mälu, kontrollib, et skript planeerib 25 kB sees samad ajakavad, et praeguse skripti tipp ei ole kõrgem kui versioonil 4.9 ja et tsükli järel alles jääv mälu jääb alla 8 kB (kaks eksemplari jagavad skriptimälu). Shelly enda mootor ja püsivara erinevad Espruinost, seega kontrolli pärast uuendamist seadmel ``mem_peak`` väärtust.

## Jälgimine ja ajakava muutmine 

> [!NOTE]
> Alates skriptiversioonist 3.9 (jaanuar 2025) loob see skript ühe ajakava, mis sisaldab kõiki vajalikke küttetunde. Kui ``SlotMinutes`` on alla 60, on selliseid ajakavu üks iga tunniveerandi kohta, kuni neli.

## Kuidas kontrollida ajakava 
Skripti loodud küttetundide vaatamiseks: 
1. Avage Shelly ajakava (Schedule). 
2. Klõpsake **Time**, et näha täielikku kütteseadme ajakava. 

|||
|-|-| 
|<img src="images/oneschedule.jpg" alt="Open Schedule" width="200">|<img src="images/editschedule.jpg" alt="Open Schedule" width="200">| 

> [!TIP] 
> Saate ajakava käsitsi muuta, klõpsates mis tahes tunnil, et see lisada või eemaldada, seejärel klõpsake Next &rarr; Next &rarr; Save.  
> Järgmine kord kui skript arvutab uue ajakava, kirjutatakse kõik käsitsi loodudmuudatused üle. 

**Kuidas jälgida skripti käivitumist**   
Andmeväli ``LastCalculation`` KVS-is värskendatakse iga kord, kui ajakavad asendatakse, nii hinnaarvutuse kui ka varuplaani järel.  
Andmeväli ``ExistingSchedule`` KVS-s on skripti loodud ajakavade ID-de loend (üks iga tunniveerandi kohta, kui ``SlotMinutes`` on alla 60).

## Skripti parameetrite konfigureerimine 

### Skripti Virtual Componentide häälestamine
> [!TIP]
> See skript kasutab **Virtuaalseid Komponente**, mis võimaldab kõiki seadeid hallata otse Shelly Cloud veebilehelt või mobiilirakendusest.  

Virtuaalseid komponente toetatakse Shelly Gen 2 Pro seadmetes ja kõigis Gen 3 ja uuemates seadmetes. 

<img src="images/ShellyVirtualComponents.jpg" alt="Shelly KVS" width="700"> 

### Kuidas panna skript tööle KVS-modes

> [!TIP]
> See skript võib käia ka KVS-modes isegi kui Virtuaalsed Komponendid on saadaval.

Seda häälestust on vaja juhul, kui antud Shelly seadme peal on juba mõni teine skript mis kasutab Virtuaalseid Komponente.
Ava skript ja pane ManualKVS parameeter ``mnKv: true``. Peale seda installeerub skript KVS-modes.

```js
let c = {
    tPer: 24,       // KVS:TimePeriod VC:Heating Period (h) 24/12/6/0
    hTim: 10,       // KVS:HeatingTime VC:Heating Time (h/period)
    isFc: false,    // KVS:IsForecastUsed VC:Forecast Heat
    pack: "VORK2",  // KVS:EnergyProvider VC:Network Package (NONE, VORK1, VORK2, VORK4, VORK5, PARTN24, PARTN24PL, PARTN12, PARTN12PL, PAMATA1, SPECIAL1)
    lowR: 1,        // KVS:AlwaysOnPrice VC:Heat On (min price) (EUR/MWh)
    higR: 300,      // KVS:AlwaysOffPrice VC:Heat Off (max price) (EUR/MWh)
    fulR: 0,        // KVS:MaxFullPrice (optional) VC: N/A, heat off if the full price (market + network + charges, VAT included) is higher (EUR/MWh), 0 = not used
    Inv: false,     // KVS:InvertedRelay VC:Inverted Relay
    rId: 0,         // KVS:RelayId VC: N/A, always first relay (0)
    cnty: "ee",     // KVS:Country VC:Market Price Country (ee, fi, lv, lt)
    hCur: 0,        // KVS:HeatingCurve VC:Heating Curve 
    sltM: 60,       // KVS:SlotMinutes (optional) VC: N/A, price slot length 15, 30, 60, 120, 180 or 240 min; 60 = hourly averages as before v5
    pFac: 0.5,      // Power factor
    mnKv: false,    // Forcing script to KVS mode (true) or Virtual components mode (false)
}
```

### Skripti KVS häälestamine

Kui skript on **KVS-modes**, saab seadeid muuta seadme veebilehe kaudu, kasutades selle IP-aadressi: Menu → Advanced → KVS.  
Kõik kasutaja häälestused asuvad JSON formaadis parameetri ``SmartHeatingConf`` all. Vaikeväärtusega võti (``InvertedRelay`` false, ``RelayId`` 0, ``HeatingCurve`` 0, ``ManualKVS`` false, ``MaxFullPrice`` 0, ``SlotMinutes`` 60) jäetakse salvestatud väärtusest välja ja selle võib käsitsi lisada: KVS väärtus mahutab 253 baiti nii, et iga jutumärk on varjestatud, seega täielik seadistus ei mahuks.

> [!IMPORTANT]
> Alates versioonist 4.2, hoitakse KVS-s andmeid JSON formaadis.  
> See aitab kaasa paremale mäluhaldusele, muuda Shelly töö stabiilsemaks ning võimaldab mitu samaaegset installatsiooni.

<img src="images/kvsConfigSettings.jpg" alt="Shelly KVS" width="550">

<img src="images/kvsConfigSettingsJson.jpg" alt="Shelly KVS" width="550">

#### Heating parameters

```
"TimePeriod": 24,
"HeatingTime": 10,
"IsForecastUsed": true,
``` 

Vaata küttereziimide osas alltoodud tabelit.

> Küttereziime saate kohandada viisil, et need sobiksid teie isiklike eelistuste ja konkreetsete olukordadega.

| Kütte režiim | Kirjeldus | Parim kasutus |
| --- | --- | --- |
| ``TimePeriod": 24,``<br>``"HeatingTime": 10,`` <br>``"IsForecastUsed": true`` | Kütmise aeg **24-tunnise** perioodi kohta sõltub **välistemperatuurist**. | Betoonpõranda kütmine või suur veepaak, mis suudab hoida soojusenergiat vähemalt 10–15 tundi. |
| ``TimePeriod": 12,``<br>``"HeatingTime": 5,``<br>``"IsForecastUsed": true`` | Kütmise aeg iga **12-tunnise** perioodi kohta sõltub **välistemperatuurist**. | Kipsivalu põrandaküte või veepaak, mis suudab hoida soojusenergiat 5–10 tundi. |
| ``TimePeriod": 6,``<br>``"HeatingTime": 2,``<br>``"IsForecastUsed": true`` | Kütmise aeg iga **6-tunnise** perioodi kohta sõltub **välistemperatuurist**. | Õhk-soojuspumbad, radiaatorid või põrandaküttesüsteemid väikese veepaagiga, mis suudab hoida energiat 3–6 tundi. |
| ``TimePeriod": 24,``<br>``"HeatingTime": 20,``<br>``"IsForecastUsed": false`` | Küte on aktiveeritud **20** kõige odavamal tunnil päevas. | Näiteks ventilatsioonisüsteem. |
| ``TimePeriod": 24,``<br>``"HeatingTime": 12,``<br>``"IsForecastUsed": false`` | Küte on aktiveeritud **12** kõige odavamal tunnil päevas. | Suur veepaak 1000L või rohkem. |
| ``TimePeriod": 12,``<br>``"HeatingTime": 6,``<br>``"IsForecastUsed": false`` | Küte on aktiveeritud **kuuel** kõige odavamal tunnil igas **12-tunnises** perioodis. | Suur veepaak 1000L või rohkem, suure kasutusega. |
| ``TimePeriod": 12,``<br>``"HeatingTime": 2,``<br>``"IsForecastUsed": false`` | Küte on aktiveeritud **kahel** kõige odavamal tunnil igas **12-tunnises** perioodis. | Väike 150L veeboiler väikesele majapidamisele. |
| ``TimePeriod": 6,``<br>``"HeatingTime": 2,``<br>``"IsForecastUsed": false`` | Küte on aktiveeritud **kahel** kõige kulutõhusamal tunnil igas **6-tunnises** perioodis. | Suur 200L veeboiler neljale või enamale inimesele mõeldud majapidamisele. |
| ``TimePeriod": 0,``<br>``"HeatingTime": 0,``<br>``"IsForecastUsed": false`` | Küte on aktiveeritud ainult slottidel, kui elektri börsihind on madalam kui määratud ``AlwaysOnPrice`` (ja mitte üle ``AlwaysOffPrice`` või ``MaxFullPrice``). Ilma perioodita ilmaprognoosi ei kasutata. |

#### ``"EnergyProvider": "VORK1"``
Elektrilevi, Imatra või Läti elektri ülekandetasude pakett. Täpsed võtmed on VORK1, VORK2, VORK4, VORK5, PARTN24, PARTN24PL, PARTN12, PARTN12PL, PAMATA1, SPECIAL1 ja NONE; tundmatu võti kirjutatakse logisse ja loetakse NONE-ks. Vali NONE, et mitte arvestada ülekandetasusid. 
Ülekandetasude üksikasjad leiab siit: [Elektrilevi](https://elektrilevi.ee/en/vorguleping/vorgupaketid/eramu) või [Imatra](https://imatraelekter.ee/vorguteenus/vorguteenuse-hinnakirjad/).

| Võrgupakett | Kirjeldus | |
| - | - | :-: |
| ``VORK1`` | **Elektrilevi**<br> Päev/öö 77 EUR/MWh | <img src="images/Vork1.jpg" alt="Elektrilevi Võrk 1" width="200"> |
| ``VORK2`` | **Elektrilevi**<br> Päeval 60 EUR/MWh <br> Öösel 35 EUR/MWh | <img src="images/Vork2-4.jpg" alt="Elektrilevi Võrk 2, 4" width="250"> |
| ``VORK4`` | **Elektrilevi**<br> Päeval 37 EUR/MWh <br> Öösel 21 EUR/MWh | <img src="images/Vork2-4.jpg" alt="Elektrilevi Võrk 2, 4" width="250"> |
| ``VORK5`` | **Elektrilevi**<br> Päeval 53 EUR/MWh <br> Öösel 30 EUR/MWh <br> Päeva tipp 82 EUR/MWh <br> Puhke tipp 47 EUR/MWh | <img src="images/Vork5-1.jpg" alt="Elektrilevi Võrk 5" width="250"> <img src="images/Vork5-2.jpg" alt="Elektrilevi Võrk 5" width="250"> |
| ``PARTN24`` | **Imatra**<br> Päev/öö 60 EUR/MWh | |
| ``PARTN24PL`` | **Imatra**<br> Päev/öö 39 EUR/MWh | |
| ``PARTN12`` | **Imatra**<br> Päeval 72 EUR/MWh <br> Öösel 42 EUR/MWh | Suveaeg päev: E-R kell 8:00–24:00.<br>Öö: E-R kell 0:00–08:00, L-P terve päev <br> Talveaeg päev: E-R kell 7:00–23:00.<br>Öö: E-R kell 23:00–7:00, L-P terve päev |
| ``PARTN12PL`` | **Imatra**<br> Päeval 46 EUR/MWh <br> Öösel 27 EUR/MWh | Suveaeg päev: E-R kell 8:00–24:00.<br>Öö: E-R kell 0:00–08:00, L-P terve päev <br> Talveaeg päev: E-R kell 7:00–23:00.<br>Öö: E-R kell 23:00–7:00, L-P terve päev |
| ``PAMATA1`` | **Läti (Sadales tīkls)**<br> Päev/öö 39,62 EUR/MWh | |
| ``SPECIAL1`` | **Läti (Sadales tīkls)**<br> Päev/öö 158,48 EUR/MWh | |
| ``NONE`` | Võrgutasu on 0 ||

#### ``"AlwaysOnPrice": 10``
Küte on igal juhul sees, kui börsihind on sellest väärtusest madalam (EUR/MWh). 

#### ``"AlwaysOffPrice": 300``
Küte on igal juhul väljas, kui börsihind ületab selle väärtuse (EUR/MWh). 

#### ``"MaxFullPrice": 0``
Vabatahtlik. Küte jääb välja igal hinnaslotil, mille täishind on sellest väärtusest kõrgem (EUR/MWh, KM sees), ka siis, kui ``AlwaysOnPrice`` sloti sisse lülitaks, ja ka ``TimePeriod`` 0 korral. Täishind on börsihind pluss ``EnergyProvider`` võrgutasu pluss riiklikud tasud, kõik käibemaksuga. Nii saab elektrit võrrelda muu kütusega arvel oleva hinna järgi: näiteks 110 tähendab 11 c/kWh. ``0`` või puuduv võti lülitab kontrolli välja ja võti salvestatakse KVS-i ainult siis, kui see on seatud. Tasud ja käibemaks on teada ainult Eesti kohta (``"Country": "ee"``: taastuvenergia tasu 8,4, aktsiis 2,1, varustuskindluse tasu 7,58, tasakaalustamisvõimsuse tasu 3,73 EUR/MWh ja KM 24 % aastal 2026); muu riigi korral jäetakse piir arvestamata ja skript kirjutab sellest logisse. Ainult KVS-is, virtuaalkomponenti ei ole: Virtual Component režiimis lisa võti ``SmartHeatingConf<id>`` JSON-i, teised võtmed võivad puududa.

#### ``"SlotMinutes": 60``
Vabatahtlik. Ühe hinnasloti pikkus minutites: ``15``, ``30``, ``60``, ``120``, ``180`` või ``240``. ``60`` (vaikimisi) planeerib tunni keskmise hinna järgi ja lülitab releed kord tunnis nagu versioonid enne 5.0; ``15`` planeerib veerandtunni hindade järgi ja lülitab iga 15 minuti tagant; pikemad slotid keskmistavad hinna 2, 3 või 4 tunni peale ja lülitavad kord sloti kohta, mis sobib soojuspumbale ja teistele seadmetele, mis ei tohi tihti lülituda. Slott peab jagama ``TimePeriod`` tervete slottideni (``240`` vajab 4, 8, 12 või 24 tunni perioodi); muu väärtus kirjutatakse logisse ja loetakse ``60``-ks. ``HeatingTime`` ümardatakse tervete slottideni alla ja ümardamine kirjutatakse logisse. Ainult KVS-is, virtuaalkomponenti ei ole: Virtual Component režiimis lisa võti ``SmartHeatingConf<id>`` JSON-i, teised võtmed võivad puududa. Võti salvestatakse ainult siis, kui see erineb ``60``-st.

#### ``"InvertedRelay": false``
Konfigureerib relee oleku kas normaalseks või pööratud.
    * ``true`` - Pööratud relee olek. Seda nõuavad mitmed maasoojuspumbad nagu Nibe või Thermia.
    * ``false`` - Normaalne relee olek, seda kasutatakse veeboilerite või elektrilise põrandakütte puhul. 

#### ``"RelayId": 0``
Shelly relay ID on vaikimisi 0, kuid mitme väljundiga Shelly puhul tähistab see relee ID numbrit.



#### ``"Country": "ee"``
Börsihinna riik. Toetatud on ainult Eleringi API riigid. * ``ee`` - Eesti * ``fi`` - Soome * ``lt`` - Leedu * ``lv`` - Läti 

#### ``"HeatingCurve": 0``
Ilmaennustuse prognoosi mõju suurendamine või vähendamine küttetundidele. Vaikeväärtus on ``0``; üks samm on üks tund kütet päevas (pool tundi 12-tunnise perioodi kohta). See seadistus kehtib ainult siis, kui kasutatakse ilmaprognoosiga kütteaga.
Vaadake kütte kõvera mõju kütte aja sõltuvusgraafikutele: [kütteaja sõltuvusgraafikud](https://github.com/LeivoSepp/Smart-heating-management-with-Shelly?tab=readme-ov-file#heating-curve).
    * ``-6`` - 6 tundi päevas vähem kütmist
    * ``6`` - 6 tundi päevas rohkem kütmist

# Kuidas seda skripti installida

## Paigaldamine

1. Hankige Shelly Plus, Pro või Gen3 seade: [Shelly seadmed](https://www.shelly.com/collections/smart-switches-dimmers).
2. Ühendage Shelly seade oma isiklikku WiFi võrku. [Shelly veebiliidese juhendid](https://kb.shelly.cloud/knowledge-base/web-interface-guides).
5. Avage Shelly seadme veebileht: Klõpsake Settings &rarr; Device Information &rarr; Device IP &rarr; klõpsake IP-aadressil. Avaneb Shelly seadme veebileht, vasakpoolses menüüs klõpsake "<> Scripts".
6. Klõpsake nuppu "Create Script" 
1. Avage skripti veebileht [Githubis](https://github.com/LeivoSepp/Smart-heating-management-with-Shelly/blob/master/SmartHeatingWidthShelly.js).
2. Klõpsake nuppu "Copy raw file". Nüüd on skript teie lõikelauamälus.  

<img src="images/CopyCode.jpg" alt="Insert code" width="450">

1. Kleepige kood lõikelaualt skripti aknasse **Ctrl+V**.
2.  Nimetage skript näiteks "Küte 24h-Ilmaprognoos" ja salvestage.
3.  Kui salvestamisprotsess on lõpule viidud, klõpsake "Start".
4.  Skripti parameetrite konfigureerimine
    - [Shelly Virtual Component kasutamine](#shelly-rakenduse-kasutamine)
    - [Shelly KVS-i kasutamine](#shelly-kvs-i-kasutamine)

## Kuidas panna tööle kaks installatsiooni

Kui Virtual Componendid on saadaval, siis esimene installatsioon kasutab neid ja ka häälestus käib nende kaudu.
Teine installatsioon saab käia paralleelselt KVS-modes. Selleks on tarvis muuta enne skritpi käivitamist parameetrit ``mnKv: true``.

### Kuidas panna skript tööle KVS-modes

> [!TIP]
> See skript võib käia ka KVS-modes isegi kui Virtuaalsed Komponendid on saadaval.

Seda häälestust on vaja juhul, kui antud Shelly seadme peal on juba mõni teine skript mis kasutab Virtuaalseid Komponente.
Ava skript ja pane ManualKVS parameeter ``mnKv: true``. Peale seda installeerub skript KVS-modes.

```js
let c = {
    tPer: 24,       // KVS:TimePeriod VC:Heating Period (h) 24/12/6/0
    hTim: 10,       // KVS:HeatingTime VC:Heating Time (h/period)
    isFc: false,    // KVS:IsForecastUsed VC:Forecast Heat
    pack: "VORK2",  // KVS:EnergyProvider VC:Network Package (NONE, VORK1, VORK2, VORK4, VORK5, PARTN24, PARTN24PL, PARTN12, PARTN12PL, PAMATA1, SPECIAL1)
    lowR: 1,        // KVS:AlwaysOnPrice VC:Heat On (min price) (EUR/MWh)
    higR: 300,      // KVS:AlwaysOffPrice VC:Heat Off (max price) (EUR/MWh)
    fulR: 0,        // KVS:MaxFullPrice (optional) VC: N/A, heat off if the full price (market + network + charges, VAT included) is higher (EUR/MWh), 0 = not used
    Inv: false,     // KVS:InvertedRelay VC:Inverted Relay
    rId: 0,         // KVS:RelayId VC: N/A, always first relay (0)
    cnty: "ee",     // KVS:Country VC:Market Price Country (ee, fi, lv, lt)
    hCur: 0,        // KVS:HeatingCurve VC:Heating Curve 
    sltM: 60,       // KVS:SlotMinutes (optional) VC: N/A, price slot length 15, 30, 60, 120, 180 or 240 min; 60 = hourly averages as before v5
    pFac: 0.5,      // Power factor
    mnKv: false,    // Forcing script to KVS mode (true) or Virtual components mode (false)
}
```

## Seadme eripärad

* Seadme skriptimootori pinu saab täis umbes viie pesastatud JavaScripti kutse juures; skript hoiab iga jätku callback'is ja kuumad tsüklid ühes funktsioonis. Uus kood jäägu nelja kutse sisse callback'ist, Node'i testid seda ei püüa.
* Lae skript üles ``tools/deploy.py`` abil (``python3 tools/deploy.py main 192.168.x.x``): see eemaldab kommentaarid (seadme koopia on siis umbes 33 kB 49 kB asemel, suurem üleslaadimine on Plus 1PM-i taaskäivitanud), teisendab teksti ASCII-ks (``Script.PutCode`` ei võta muid märke), laeb 1 kB tükkidena, loeb koodi tagasi ja käivitab skripti. ``tools/deploy.py verify`` näitab skripti olekut, relee taimerit, KVS-i ja ajakavu; ``tools/deploy.py kvs`` seab seadistuse väärtuse.
* Seadme logi (``ws://192.168.x.x/debug/log``, vaikimisi sees) näitab skripti printe ja vigu; ``tools/deploy.py log 60`` salvestab seda minuti.
* KVS väärtus mahutab 253 baiti nii, et iga jutumärk on varjestatud, vt [Skripti KVS häälestamine](#skripti-kvs-häälestamine).

## Skripti uuendamine


> [!WARNING] 
> Versioonilt 4.1 ei ole uuendamine võimalik, kuna KVS andmevorming on uuemates versioonides JSON.  
> Peale intallatsiooni, on vaja häälestused käsitsi üle käia nii Virtual Komponentide kui ka KVS-i puhul.

1. Avage skripti veebileht [Githubis](https://github.com/LeivoSepp/Smart-heating-management-with-Shelly/blob/master/SmartHeatingWidthShelly.js).
2. Klõpsake nuppu "Copy raw file". Nüüd on skript teie lõikelauamälus.  
3. Avage Shelly seadme veebilehelt: navigeerige Settings → Device Information &rarr; Device IP &rarr; klõpsake IP-aadressil. Avaneb Shelly seadme veebileht; vasakpoolses menüüs valige "<> Scripts."
4. Avage skript, mida soovite uuendada.
5. Valige kogu skriptikood ja kustutage see **Ctrl+A** &rarr; **Kustuta**.
6. Kleepige kood lõikelaualt skripti aknasse **Ctrl+V**.
7. Salvestage skript, versioon on nüüd uuendatud.
8. Kõik konfiguratsioonid jäävad samaks, kuna need on salvestatud KVS-i või virtuaalsetesse komponentidesse.

## Kuidas kontrollida et skript töötab

1. Shelly rakenduses või veebilehel navigeerige "Schedules" (Ajakavad).
2. Kontrollige Shelly aktiveerimise ajakava.
3. Edasijõudnud kasutajad saavad kontrollida KVS-i salvestust: [Advanced → Key Value Storage → Script Data](#advanced--key-value-storage--script-data)

## Kuidas skript töötab

1. Internetiühendus:
    * Skript vajab internetti, et alla laadida igapäevaseid elektrihindu ja ilmaprognoose.
2. Igapäevane töö:
    * Skript töötab iga päev pärast kella 23:45 või vastavalt vajadusele päeva jooksul, et määrata küttetunnid.
3. Töövoog:
    * Skript järgib vooskeemi, et määrata parimad kütmissetunnid turuhindade ja ilmaprognooside põhjal.


```mermaid
flowchart TD
    0@{ shape: circle, label: "Start" } --> A
    A[Get Shelly time and location] --> K{Is forecast used?}
    K -- Yes --> B{Get forecast <br> from Open-Meteo.com API}
    B -- Succeeded </br>Calculate heating time --> D{Get market price <br> from Elering API}
    K -- No --> D
    B --> M@{ shape: subproc, label: "Failed</br>Check again in 5 minute" }
    D -- Succeeded</br>Calculate heating schedules --> L{Check, if market price and </br> forecast needs update}
    D --> M
    L --> M
    L -- Yes</br>Start the script --> 0
```

4. Watchdog workflow

```mermaid
flowchart TD
    0@{ shape: circle, label: "Start" } --> A
    A[Create 'watchdog' </br>event handler] --> K{Is heating script </br>stopped or deleted?}
    K -- Yes --> B[Find the script schedule</br>and delete it]
```

## Oluline teada

* <p>Kui skript peatatakse, kustutatakse kütte ajakava. Shelly järgib kütte algoritmi ainult siis, kui skript töötab.</p>
* <p>Kaks skripti installatsiooni saab käia korraga, kui esimene neist töötab Virtuaalsete Komponentidega, siis teine saab olla ainult KVS modes.
* <p>KVS-režiimis võib korraga töötada kuni kaks erineva algoritmiga skripti ühel seadmel. Skriptid võivad kasutada kas sama releeväljundit Shelly Plus 1-ga või erinevaid releeväljundeid, nagu toetab näiteks Shelly Plus 2PM. Sama releed jagavad skriptid peavad kasutama sama ``SlotMinutes`` ja ``InvertedRelay`` väärtust: viimane arvutus seab relee väljalülitustaimeri mõlemale.</p>
* <p>See skript loob spetsiaalse "valvuri/watchdog" skripti. See "valvuri" skript kustutab Shelly kütte ajakava kui põhiskript peatatakse või kustutatakse.</p>
* <p>Interneti katkestuste mõju vähendamiseks kasutab see skript parameetrit ``heating time``, et lülitada küte ajalooliselt odavamate tundide järgi sisse.</p>
* <p>Selle skripti "Run on startup" nupp peab olema aktiveeritud. See seadistus tagab, et skript käivitub pärast voolukatkestust, Shelly taaskäivitust või püsivara uuendamist.</p>
* <p>See skript haldab ainult tema enda loodud kütte ajakava. See skript kustutab ainult selle ajakava, mille ise on loonud.</p>
* <p>See lahendus on kasulik ainult siis, kui teil on börsihinnaga elektrileping. Kui teie elektrileping on kindla hinnaga, siis antud lahendus ei aita rahalist kokkuhoidu saavutada.</p>
* See skript sõltub internetist ja kahest teenusest:
    * Elektrituru hind [Eleringi API](https://dashboard.elering.ee/assets/api-doc.html#/nps-controller/getPriceUsingGET),
    * Ilmaprognoos [Open-Meteo API](https://open-meteo.com/en/docs).
* <p>Shelly Gen2 Plus seadmete püsivara peab olema versioon 1.4.4 või uuem. KVS andmed on kirjutuskaitstud, kui püsivara versioon on 1.4.3 või vanem.
* <p>Shelly Gen2 Pro või Gen3 seadmete püsivara peab olema versioon 1.4.4 või uuem. Skript ei installi virtuaalseid komponente, kui püsivara versioon on 1.4.3 või vanem.

## Testitud rikkestsenaariumid
Alltoodud rikete ajal kasutab Shelly ``Heating Time`` kestust, et lülitada küte ajalooliselt odavamate tundide järgi sisse.  
Internetirikke korral jagab Shelly oma küttetunnid vastavalt häälestatud perioodide vahel.

**Testitud rikkestsenaariumid**
1. Shelly töötab edasi, kuid internet läheb maha kodurouteri või internetiteenuse pakkuja rikke tõttu. Shelly kellaaeg jääb korrektseks.
2. Pärast voolukatkestust internet ei tööta ja Shellyl puudub kellaaeg: skript ootab kellaaega ja planeerib kohe, kui see on olemas (ajakavad ei saa ilma kellata käivituda).
3. Eleringi HTTP viga tekib ja Eleringi server pole kättesaadav.
4. Eleringi API rike juhtub ja teenus on maas.
5. Eleringi API tagastab valed andmed ja hinnad puuduvad.
6. Ilmaprognoosi HTTP viga tekib ja server pole saadaval.
7. Ilmaprognoosi API teenuse viga tekib ja JSON andmeid ei saada.

# Maasoojuspumpade Thermia Villa & Eko Classic nutikas kütmine Shelly abil

Thermia Villa ja Thermia Eko Classic on küll suhteliselt vanad, kuid siiski hästi tööötavad ja päris populaarsed maasoojuspumbad. 
Käesolev juhis nõustab kuidas need soojuspumbad Shelly abil nutikalt kütma panna.

Instruktsioonid ja ühendused  
(Esiteks mõlema soojuspumba installer manualist pilt.)

|Thermia Villa|Thermia Eko Classic|
|---|---|
| <img src="images/ThermiaVilla.jpg" alt="Thermia Villa" width="450"> | <img src="images/ThermiaEkoClassic.jpg" alt="Thermia Eko Classic" width="410"> |

Ühenda **kaks Shelly seadet** maasoojuspumba sees vastavalt **skeemile**.

 <img src="images/ThermiaShelly.jpg" alt="Connect Thermia and Shelly" width="500">

Alljärgnevast tabelist leiad kuidas **häälestada oma Shelly seadmed**.  
Mõlemale Shelly seadmele installeeri Smart Heating skript ja häälesta vastavalt kas kütte või sooja vee tootmise jaoks.

|Heatpump|Heating+Hot Water|only Hot Water|
|---|---|---|
|Thermia Villa|Shelly 1<br>``"InvertedRelay": true``|Shelly 2<br>``"InvertedRelay": true``|
|Thermia Eko Classic|Shelly 1<br>``"InvertedRelay": true``|Shelly 2<br>``"InvertedRelay": false``|

Siin on **soojuspumba tööolukorrad** lihtsalt infoks.

|Thermia Villa|Thermia Eko Classic|Shelly 1|Shelly 2|
|---|---|---|---|
|EVU Stop <br>No heating or hot water|Hot water <br> Reduced Temperatur|On|On|
|Hot Water<br> Reduced Temperatur|EVU Stop<br>No heating or Hot water|On|Off|
|Normal heating <br>Normal Hot water|Normal heating <br>Normal Hot water|Off|On|
|Normal heating <br>Normal Hot water|Normal heating <br>Normal Hot water|Off|Off|

# Nutikad kütte algoritmid

## Ilmaprognoosi algoritm

> [!TIP] 
> See algoritm arvutab järgmise päeva kütteaja ilmaprognooside põhjal.  
> See on eriti tõhus erinevate koduküttesüsteemide jaoks, kuna optimeerib küttevajaduse eeldatavate ilmastikuoludega.

### Ilmaprognoosipõhise kütmise eelised

* Välistemperatuurile reageerimine:

Kui välistemperatuur on +17 kraadi, pole üldjuhul kütmist vaja. Kui aga temperatuur langeb -5 kraadini, on vajalik mõningane kütmine ja eriti külmades tingimustes, nagu -20 kraadi, on vaja märkimisväärselt kütmist. Ilmateade kohandab kütmiseks võetavate tundide arvu vastavalt välistemperatuurile.

* Nutikas kütte haldamine:

Ilmaprognooside kasutamine võimaldab nutikat ja kohanduvat küttehaldust. Süsteem kohandab küttetunde välise temperatuuri põhjal, luues reageeriva ja dünaamilise kütte ajakava.

* Asukohapõhine prognoos:

Täpse ilmaprognoosi saamiseks on tarvis teada asukohta, et arvutada välja parim küttestrateegia.

### Shelly geograafiline asukoht

> [!IMPORTANT]
> Veenduge, et teie Shelly seadmel oleks õige asukohateave, kontrollides Shelly &rarr; Seaded &rarr; Geolokatsioon &rarr; Laiuskraad/pikkuskraad.

Märkus: Shelly asukoht määratakse teie internetiteenuse pakkuja IP-aadressi põhjal, mis ei pruugi täpselt kajastada teie kodu asukohta. Kontrollige ja uuendage vajadusel laius- ja pikkuskraadi seadeid.

### Küttegraafik

Temperatuuri ja kütteaja vaheline seos on tuntud kui *küttegraafik*.

Kütteaega mõjutab teie maja isolatsioon. Näiteks vana ja soojustamata maja võib vajada -5 kraadi juures 10 tundi kütmist, samas kui uus A-klassi maja vajab võib-olla ainult 6 tundi.

Nende erinevuste arvestamiseks sisaldab skript parameetrit ``heatingCurve``, mis võimaldab kasutajal kohandada küttetegurit vastavalt maja soojapidavusele.

* 24-tunnise perioodi graafik iseloomustab kuidas kütteaeg varieerub välistemperatuuri ja ``heatingCurve`` parameetri põhjal, mis omakorda nihutab küttegraafikut vasakule või paremale, üks samm on üks tund päevas. 

<img src="images/HeatingCurve24.jpg" alt="Küttegraafik 24-tunniseks perioodiks" width="750">

____

* 12-tunnise perioodi küttegraafik ja kütteaja sõltuvus välistemperatuuri ja ``heatingCurve`` parameetrist.

<img src="images/HeatingCurve12.jpg" alt="Küttegraafik 12-tunniseks perioodiks" width="750">

Kui matemaatiline pool huvitab, siis küttetunde päevas on ``(16 - T) * PowerFactor + HeatingCurve - 2``, kus ``T`` on tajutava temperatuuri prognoosi keskmine ja ``PowerFactor`` 0,5: üle 16 °C kütet ei ole, 0 °C juures 6 tundi ja -10 °C juures 11 tundi ``HeatingCurve`` 0-ga, kõige rohkem terve periood. 12- või 6-tunnine periood saab oma osa päevast, ümardatuna tervete slottideni alla. Tabelid on skripti päises.

## Ajaperioodi algoritm

> See algoritm jagab päeva perioodideks, aktiveerides kütte kõige odavamatel tundidel igas perioodis. See sobib hästi kasutusjuhtudeks, nagu kuumavee boilerid, kus kasutus sõltub majapidamise suurusest ja mitte välistemperatuurist. See meetod optimeerib energiakasutust ning vesi püsib soe kõige madalamate elektri börsi hindadega.

* 24-tunnine graafik ja kuidas 10 kõige odavamat tundi valitakse, on näitena kujutatud järgmisel pildil. Punane tähistab kütmiseks kasutatavaid tunde.

<img src="images/Heating24_10.jpg" alt="Kütteperiood 24 tundi" width="750">

___

* 4-tunnine graafik ja kuidas 1 kõige odavam kütmise tund valitakse iga 4-tunnise perioodi kestel.

<img src="images/Heating4_1.jpg" alt="Kütteperiood 4 tundi" width="750">

</br>

# Kas see tõesti vähendab minu elektriarveid
Lühidalt: jah.

Siin on ka üksikasjalikum selgitus. Kuigi teie üldine igapäevane elektritarbimine jääb samaks, optimeerib see skript teie kütteseadmete töö kõige odavamatele tundidele. Seetõttu väheneb teie elektriarve, kuigi energia tarbimine jääb samaks.

Sellised seadmed nagu veeboilerid, veepaagid, maakütte- või õhksoojuspumbad, elektriradiaatorid, põrandakütte elektrisüsteemid ja konditsioneerid on seadmed, mis annavad kõige suurema kasu börsihinnaga juhtimisel.

Elektrihinnad võivad kõikuda märkimisväärselt, varieerudes päeva jooksul kuni 100 korda. Elektrituru hindade kohta lisateabe saamiseks vaadake järgmist linki: [Elering](https://dashboard.elering.ee/et/nps/price)


# Tõrkeotsing

## Viga "Couldn't get script"

Shelly süsteemis on probleem, mis võib mõjutada teie kogemust skriptide avamisel Shelly pilve või mobiilirakenduse kaudu. Tekkinud viga "Couldn't get script" on teadaolev bugi, mis takistab skriptide avamist, mis on suuremad kui 15kB nende platvormide kaudu.

Selle ebamugavuse ületamiseks soovitame järgmisi lahendusi:

1. Avage skript seadme veebilehe kaudu:
Juurdepääs seadme veebilehele võimaldab teil edukalt avada mis tahes skripti. See meetod pakub otsest ja usaldusväärset lahendust, et vaadata ja hallata oma skripte sujuvalt.

2. Alternatiivne lahendus Shelly pilve kaudu:
Kui seadme veebilehele juurdepääs ei ole võimalik, järgige neid samme Shelly pilves:

   1. Kustutage olemasolev skript.
   2. Looge uus skript.
   3. Kopeerige ja kleepige kogu skript skripti aknasse.
   4. Salvestage ja sulgege skript.
   5. Käivitage skript.

    Kui selle protsessi käigus tekib probleeme, saate seda lahendust korrata, alustades skripti kustutamise sammust.

<img src="images/CouldntGetScript.jpg" alt="Couldn't get script." width="750">

## Advanced &rarr; Key Value Storage &rarr; Script Data

Skript salvestab andmed Shelly KVS (Key-Value-Storage) säilitamaks neid elektrikatkestuste või taaskäivituste korral.

Salvestatud andmete juurde pääsemiseks Shelly seadme veebilehe kaudu, navigeerige **Advanced &rarr; KVS**.

1. Parameeter: ``ExistingSchedule`` Väärtus: ``[12,13,14,15]``
   
    Skripti loodud ajakavade ID-d, üks iga tunniveerandi kohta, kui ``SlotMinutes`` on alla 60. Skript kustutab enne uute loomist täpselt need ajakavad ja watchdog kustutab need, kui skript peatub. 

2. Parameeter: ``LastCalculation`` Väärtus: ``Fri Dec 27 2024 23:29:20 GMT+0200`` 
   
   See ajatempel näitab aega, millal skript sai edukalt Eleringi API kaudu börsihinnad ja tekitas kütmise jaoks ajakava. See teave pakub head ülevaadet skripti tegevuse ajakavast.

3. Parameeter: ``Version`` Väärtus: ``4.3`` 
   
   Versioon näitab installitud skripti versiooni.

<img src="images/KvsSystem.jpg" alt="Key Value Storage" width="750">


# Litsents

See projekt on litsentseeritud MIT litsentsi alusel. Vaadake [LITSENTS](LICENSE) faili üksikasjade saamiseks.

# Autor

Loodud Leivo Sepp, 2024-2025

[Smart heating management with Shelly - GitHub Repository](https://github.com/LeivoSepp/Smart-heating-management-with-Shelly)