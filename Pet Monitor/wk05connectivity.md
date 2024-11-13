# Hardware Connectivity Status Update
Our project is an automated pet feeding and healthcare system. It serves the primary function of dispensing food and water to your pet at scheduled intervals while also tracking its weight fluctuations. Our device is engineered to meticulously monitor the pH level of your pet's drinking water and the ambient room temperature, mitigating the risk of overheating.
## Recent and current progress
Worked on kicad files for PH sensor and resistive sensor. Worked on the first prototype for the case that would house all the sensors and worked on connecting the Raspberry Pi to Firebase. The Raspberry Pi connects to the campus Wi-Fi with no problems most of the time and when it does have difficulty connecting it gets fixed by forgetting the Wi-Fi and then connecting again. Having difficulties connecting the Raspberry Pi to Firebase. The Mini dToF Imager - TMF8820 has two 2.2kΩ pull-up resistors to the I2C data lines that are clearly labelled and can be easily cut.
## Problems and hyperlinks/urls to potential solutions
Having problems connecting the sensors to the database. 

Example of connecting an Android app that uses Firebase to Raspberry Pi [Example of Firebase, Android app, and Raspberry Pi](https://www.hackster.io/ahmedibrrahim/iot-using-raspberry-pi-and-firebase-and-android-dbe61d)

Send data to Firebase from Raspberry Pi [Pi to Firebase example](https://my.cytron.io/tutorial/send-data-to-firebase-using-raspberry-pi)

For students using only a Raspberry Pi consider pyrebase
For students also using an Arduino take a look at [Raspberry Pi Arduino USB Communication](https://roboticsbackend.com/raspberry-pi-arduino-serial-communication/)   
## Financial
### Expenditures since previous report
Printed out the prototype of the case that used about 100g of filament.
### Planned future expenses
More 3d printing.
