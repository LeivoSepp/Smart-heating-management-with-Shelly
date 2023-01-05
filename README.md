# Smart energy price for Shelly

This script will turn on Shelly for number of cheapest hours during a day.
It's scheduled to run daily after 23:00 to set proper timeslots for next day.

Before running script you must define the amount of cheapest hours you want to see "needed_length=5".
Example:
If number is set to 5 then Shelly will turn on for 5 most cheapest hours during a day. 
If cheapest hours are 02:00, 04:00, 07:00, 15:00 and 16:00, then Shelly is turned on for 02-03, 04-05, 07-08 and 15-17 (two hours in a row).

Some heating systems requires reversed relay. Put "is_reverse = true" if the heating management requires so.
For example my personal heating system is requires the reversed management.

Internet is brokem sometimes and if fetching prices fails from the internet, then use predefined "default_start_time = 1" where 1 means 01:00. 
if "needed_length = 5", then Shelly is turned on from 01:00 to 06:00

Shelly is turned on by schedulers and will be turned off by automatic one hour countdown timer to flip the status.

Market price generation credit goes to this guy https://elspotcontrol.netlify.app/. 
He is taking care that the market price is published in each day into this place: https://elspotcontrol.netlify.app/spotprices-v01-EE.json
Please have a look the EE in the link which reflects country.

