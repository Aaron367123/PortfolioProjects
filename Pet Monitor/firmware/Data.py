import time
import board
import busio
import Adafruit_ADS1x15
import adafruit_dht
import adafruit_ads1x15.ads1015 as ADS
from adafruit_ads1x15.analog_in import AnalogIn
import struct
import fcntl
import io
import pyrebase
from firebase import firebase

config = {
  # You can get all these info from the firebase website. It's associated with your account.
  "apiKey": "AIzaSyADldspq2oeqF0tZH2ACoDAV9YhGkHMCHU",
  "authDomain": "smartfeeder-b0546.firebaseapp.com",
  "databaseURL": "https://smartfeeder-b0546-default-rtdb.firebaseio.com/",
  "project_id": "smartfeeder-b0546",
  "storageBucket": "smartfeeder-b0546.appspot.com"  
}

firebase=pyrebase.initialize_app(config)

db=firebase.database()

# Initialize I2C bus
i2c = busio.I2C(board.SCL, board.SDA)

# Create DHT22 sensor object
dht_device = adafruit_dht.DHT22(board.D4)

# Create ADS1015 ADC instance using CircuitPython library
ads = ADS.ADS1015(i2c, address=0x48)
chan_A0 = AnalogIn(ads, ADS.P0)
chan_A1 = AnalogIn(ads, ADS.P1)

# Open I2C handle for person sensor
PERSON_SENSOR_I2C_ADDRESS = 0x62
I2C_CHANNEL = 1
I2C_PERIPHERAL = 0x703
PERSON_SENSOR_DELAY = 1
PERSON_SENSOR_I2C_HEADER_FORMAT = "BBH"
PERSON_SENSOR_I2C_HEADER_BYTE_COUNT = struct.calcsize(
    PERSON_SENSOR_I2C_HEADER_FORMAT)

PERSON_SENSOR_FACE_FORMAT = "BBBBBBbB"
PERSON_SENSOR_FACE_BYTE_COUNT = struct.calcsize(PERSON_SENSOR_FACE_FORMAT)

PERSON_SENSOR_FACE_MAX = 4
PERSON_SENSOR_RESULT_FORMAT = PERSON_SENSOR_I2C_HEADER_FORMAT + \
    "B" + PERSON_SENSOR_FACE_FORMAT * PERSON_SENSOR_FACE_MAX + "H"
PERSON_SENSOR_RESULT_BYTE_COUNT = struct.calcsize(PERSON_SENSOR_RESULT_FORMAT)

i2c_handle = io.open("/dev/i2c-" + str(I2C_CHANNEL), "rb", buffering=0)
fcntl.ioctl(i2c_handle, I2C_PERIPHERAL, PERSON_SENSOR_I2C_ADDRESS)

while True:
    try:
        # Read temperature and humidity from DHT22 sensor
        temperature_c = dht_device.temperature
        db.child("temperatureData").set({"temp_C": temperature_c})
        print("Temp data sent")
        # Read voltage from ADC
        weight = max(0, chan_A1.value)
        db.child("weight").set({"weight": weight})
        print("Weight data sent")
    except Exception as e:
        print("ADC error:", e)

    try:
        # Read voltage from ADS1015 ADC using CircuitPython library
        pH = chan_A0.voltage
        db.child("ph").set({"pH": pH})
        print("pH data sent")
    except Exception as e:
        print("ADS1015 error:", e)
        
    try:
        read_bytes = i2c_handle.read(PERSON_SENSOR_RESULT_BYTE_COUNT)
    except OSError as error:
        print("No person sensor data found")
        print(error)
        time.sleep(PERSON_SENSOR_DELAY)
        continue
    offset = 0
    (pad1, pad2, payload_bytes) = struct.unpack_from(
        PERSON_SENSOR_I2C_HEADER_FORMAT, read_bytes, offset)
    offset = offset + PERSON_SENSOR_I2C_HEADER_BYTE_COUNT

    (num_faces) = struct.unpack_from("B", read_bytes, offset)
    num_faces = int(num_faces[0])
    offset = offset + 1

    faces = []
    for i in range(num_faces):
        (box_confidence, box_left, box_top, box_right, box_bottom, id_confidence, id,
         is_facing) = struct.unpack_from(PERSON_SENSOR_FACE_FORMAT, read_bytes, offset)
        offset = offset + PERSON_SENSOR_FACE_BYTE_COUNT
        face = {
            "box_confidence": box_confidence,
            "box_left": box_left,
            "box_top": box_top,
            "box_right": box_right,
            "box_bottom": box_bottom,
            "id_confidence": id_confidence,
            "id": id,
            "is_facing": is_facing,
        }
        faces.append(face)
    checksum = struct.unpack_from("H", read_bytes, offset)
    
    faces_detected = num_faces >= 1
    
    db.child("presence").set({"faces_detected": faces_detected})
    print("Presence data sent")

    time.sleep(1)  # Adjust the delay as needed
