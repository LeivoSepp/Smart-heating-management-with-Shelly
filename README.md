# Smart and cheap heating with Shelly

This Shelly script downloads energy market prices from Elering and will turn on heating for cheapest hours in a day using different algorithms. This is perfect solution to make any heating system smart. 
This script supports three different scenarios/algorithms:
1. Heating time for the next day is based on the weather forecast. Cold weather -> more heating hours. 
2. Heating time (24h) is divided into periods and heating turned on for a number of cheapest hour.
3. Heating is turned on-off based on the predefined price levels.

Configuration parameters: 

* ``let country = "ee";             // Estonia-ee, Finland-fi, Lithuania-lt, Latvia-lv``
* ``let heatingWindow = 24;         // time period (hours), (0 -> only min-max price used, 24 -> one day)``
* ``let heatingTime = 5;            // heating time in each time period (hours)``
* ``let alwaysOnMaxPrice = 10;      // heating is always on if energy price lower than this value (transfer fee not included)``
* ``let alwaysOffMinPrice = 300;    // heating is always off if energy price higher than this value (transfer fee not included)``
* ``let isInvertedOutput = false;   // Some heating systems requires inverted relay.``
* ``let isWeatherForecastUsed = true; //use weather forecast to calculate heating time dynamically for every day``
* ``let dayRate = 56;               // Day electricity transmission fee without tax (EUR/MWh)``
* ``let nightRate = 33;             // Night electricity transmission fee without tax (EUR/MWh)``


#  ↓↓↓ waiting for update ↓↓↓ 

Smart heating can be based on different algorithms. There are two of them used by myself:
1. Full day heating, weather forecast and electricity market price. [1. Full Day Heating](#1-full-day-heating)
2. Many heating windows and electricity market price. [2. Heating Windows](#2-heating-windows)

Whats the difference between these algorithms?

|Feature|Full day heating|Heating windows|
|---|---|---|
|Best usage|Floor heating, big water tank or other sources which can store the energy for longer time.|Air source heat pumps, water heating or other places where heating required in regular basis.|
|How it works?|Heating time is based on weather forecast and then cheapest hours chosen from the day for heating.|Day is divided into many heating window and cheapest hour from each window is used for heating.|
|Example|<img src="images/smartheating.jpg" alt="Full day heating" width="400">|<img src="images/HeatingWindow.jpg" alt="Heating windows" width="400">|
|Pros|Biggest money saving.|Smoother heating.|
|Cons|The time between heating hours can be too long and it might not OK for water heating.|In the middle of the day the hours can be very expensive and this decrease your savings.|
||||

<br/><br/>

# 1. Full day heating

## 1.1 What does this script doing?
This script is calculating required heating time based on [weather forecast](https://open-meteo.com/), and turns on your heating system for cheapest hours in a day based on [electricity market price](https://dashboard.elering.ee/et/nps/price).

<img src="images/smartheating.jpg" alt="Full day heating" width="700">

It's scheduled to run daily after 23:00 to set heating schedule for next day.

This script works with [Shelly Pro/Plus devices](https://www.shelly.cloud/en-ee/products/) which supports scripting.

This script depends on two services:
* electricity market price from [Elering API](https://dashboard.elering.ee/assets/api-doc.html#/nps-controller/getPriceUsingGET),
* weather forecast from [Open-Meteo API](https://open-meteo.com/en/docs).

## 1.2 Does it really reduce my electric bills?

Short answer: yes.

Long answer. Your overall daily electric consumption will stay same, but this script will turn on your heating devices for cheapest hours. 

Thats why the electricity bill is smaller even you consume same amount of energy.

Some of the energy hungry appliances are water heater, air-source or ground-source heatpump, electric radiator, underfloor electric heater, air conditioning and it makes sense to turn them on during cheapest time of a day.

Electicity price can vary sometimes 100 times during a day. Check  [electricity market prices](https://dashboard.elering.ee/et/nps/price).

![Energy price variability](/images/marketpriceexample.jpg)

**IMPORTANT**

> You will only benefit in case of having hourly priced energy contract. If your energy contract has one flat rate, then this solution will not help to redure your energy bill.

This will work for Estonia-ee, Finland-fi, Lthuania-lt and Latvia-lv.
Electricity market prices for other countries do not exist in Elering API.

Set your country parameter ``country = "ee"``.

## 1.3 Why the heating hours are based on weather forecast?

If outside temperature is +20 degrees, you don't need heating. This is so true.

If temperature is -5 degrees you need some heating but for -20 degrees you need much more heating. This is also true.

Now you got why weather forecast is very important for calculating next day heating time. This is a smart way to manage heating system.

To get your home weather forecast, location data is needed. 

**IMPORTANT**

> Please make sure your Shelly device has correct location. Shelly - Settings - Geolocation - Latitude/Longitude.

> Shelly location is based on your internet provider IP-address and it is very likely not your home location.

<img src="images/ShellyLocation.jpg" alt="Shelly geolocation" width="400">

Copy values from latitude and longitude fields and put them into googl maps to know which place is identified by Shelly.

<img src="images/checklocation.jpg" alt="Check location" width="500">

If you are not satisfied with the Shelly identified location then put a pin into googl maps, copy latitude/longitude and overwrite your Shelly location.

<img src="images/locationdata.jpg" alt="Find location data with googl maps" width="500">

The temperature and heating time relationship is called **heating curve**.

## 1.4 How the heating curve looks like?

Heating time is based on your household insulation. For example an old and not insulated house needs 10 h heating if outside is -5 degrees, while new A-class house might need only 4 hours.

This is the reason the scipt has parameter ``heatingCurve`` which is used to set the best heating curve for each household.  

This graph shows how the heating time is dependent on temperature and a parameter ``heatingCurve``.

**IMPORTANT**

> You can start using this script with the default ``heatingCurve = 5``, and take a look how this works for you. If you feel cold, then increase this number. If you feel too warm, then decrease this number. 

![Heating curve](/images/HeatingCurve.jpg)

If you like math, then this is the quadratic equation to calculate heating time: ``(startingTemp-avgTemp)^2 + (heatingCurve / powerFactor) * (startingTemp-avgTemp)``.

* ``startingTemp = 10 `` is used as starting point for heating curve.
* ``avgTemp = -5 `` is the average next day temperature forecast.
* ``heatingCurve = 5 `` is used to set the best heating curve for your household.
* ``powerFactor = 0.2 `` is used to set quadratic equation parabola curve flat or steep.

You can build your own heating curve equation if you feel comfortable to do so.

## 1.5 How to use this script?

1. Go and buy any [Shelly Pro/Plus devices](https://www.shelly.cloud/en-ee/products/). Shelly device must be a [Gen 2 device](https://shelly-api-docs.shelly.cloud/gen2/) to support scripting. Let's make it simple, the name must contain *Plus* or *Pro*. 
2. Connect Shelly device to WiFi network. [Shelly web interface guides.](https://kb.shelly.cloud/knowledge-base/web-interface-guides)
3. Find Shelly IP address and go to page (put your own IP address) http://192.168.33.1/#/script/1
4. Add script, just copy the [script](https://github.com/LeivoSepp/Smart-heating-management-with-Shelly/blob/master/SmartHeatingWidthShelly.js) and paste it to Shelly scripting window.
5. Configure required parameters:
    - Set the country code. Possible values: Estonia-ee, Finland-fi, Lthuania-lt, Latvia-lv. ``country = "ee"``
    - Set heating curve based on your household: ``heatingCurve = 5``
6. Configure optional parameters:
    - Set the number of cheap hours required during a day. This is used in case the weather forecast can't be get. Values in range 1-24.  ``heatingTime = 5``  
    - Set default start time which is used in case get energy price is failed. Values in range 0-23.  ``default_start_time = 1``
    - Set relay mode - normal or reversed. Values true/false. ``is_reverse = false``. 99% of the cases this parameter should be false. Don't change it.
7. Click "Save" and "Start". 

## 1.6 How this script works?

1. This script requires internet connection to download daily basis electricity market prices and weather forecast.
2. After first run, the script creates a schedule for itself and runs daily basis between 23:00-23:15.
3. The script follows this flowchart.

```mermaid
flowchart TD
    0[Start] --> A
    A[Get Shelly time and location] --> B{Get weather forecast <br> from Open-Meteo.com API}
    B -- Succeeded --> C[Calculate heating time]
    C --> D{Get electricity market price <br> from Elering API}
    B -- Failed --> E[Use default heating time]
    E --> D
    D -- Succeeded --> F[Create hourly schedules]
    D -- Failed --> G[Create one big heating time]
    F --> H[Finish]
    G --> H
```
<br/><br/>

# 2. Heating Windows

## 2.1 What does this script doing?
This script divides day into heating windows, finds cheapest hour(s) from each window, and turns on heating for that time.

<img src="images/HeatingWindow.jpg" alt="Heating windows" width="750">

It's scheduled to run daily after 23:00 to set heating schedule for next day.

This script works with [Shelly Pro/Plus devices](https://www.shelly.cloud/en-ee/products/) which supports scripting.

This script depends on the [Elering API](https://dashboard.elering.ee/assets/api-doc.html#/nps-controller/getPriceUsingGET), to get electricity market price.

## 2.2 How to use this script?

1. Go and buy any [Shelly Pro/Plus devices](https://www.shelly.cloud/en-ee/products/). Shelly device must be a [Gen 2 device](https://shelly-api-docs.shelly.cloud/gen2/) to support scripting. Let's make it simple, the name must contain *Plus* or *Pro*. 
2. Connect Shelly device to WiFi network. [Shelly web interface guides.](https://kb.shelly.cloud/knowledge-base/web-interface-guides)
3. Find Shelly IP address and go to page (put your own IP address) http://192.168.33.1/#/script/1
4. Add script, just copy the [script](https://github.com/LeivoSepp/Smart-heating-management-with-Shelly/blob/master/HeatingWindows.js) and paste it to Shelly scripting window.
5. Configure required parameters:
    - Set the country code. Possible values: Estonia-ee, Finland-fi, Lthuania-lt, Latvia-lv. ``country = "ee"``
    - Set the length of heating window in hours. In normal cases I would recommend to set it between 4 to 8, but can be 1-24 (24 is useless). ``heatingWindow = 5``
    - Set the number of heating hours inside of each heating window. In normal cases it should 1 or 2 hours, but can also be bigger number. ``heatingTime = 1``
6. Configure optional parameters:
    - Set relay mode - normal or reversed. Values true/false. ``is_reverse = false``. 99% of the cases this parameter should be false. Don't change it.
7. Click "Save" and "Start". 

<br/><br/>

# 3. How to add script into Shelly

Shelly IP address can be found under Setting - Device Information - Device IP. Just click on the IP address and new Shely window will open.

<img src="images/OpenShellyPage.jpg" alt="How to find Shelly IP address" width="400">

- In Shelly page click "Scripts" and "Add script".

<img src="images/AddScript1.jpg" alt="How to add script" width="400">

- Give a name to the script.
- Copy the code from this [page](https://github.com/LeivoSepp/Smart-energy-price-for-Shelly/blob/master/SmartHeatingWidthShelly.js).  
- Paste the text into script window.
- Click Save.

<img src="images/AddScript2.jpg" alt="Where to paste the script" width="400">

* Click "Start"!
* Click "Scripts" to go back into scipts list.
* Enable the script to run automatically in each day.

<img src="images/AddScript3.jpg" alt="Enable script" width="400">

## 4. How can I see the outcome?

In Shelly page click "Home" and then click "Switch0" and then find "Schedules" and "Timers".

<img src="images/CheckSchedules1.jpg" alt="Check schedules" width="400">

The schedulers can be seen also in page https://home.shelly.cloud/.

<img src="images/CheckSchedules2.jpg" alt="Check schedules" width="400">

