const express = require('express');
const cors = require('cors');
const { InfluxDB } = require('@influxdata/influxdb-client');
const mqtt = require('mqtt');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public')); // ให้ Express เสิร์ฟไฟล์หน้าเว็บจากโฟลเดอร์ public   
app.use(cors()); 
app.use(express.json()); // ให้ Express อ่าน JSON จากหน้าเว็บได้

// ==========================================
// 1. ตั้งค่า InfluxDB (เชื่อมต่อฐานข้อมูล Cloud)
// ==========================================
const url = 'https://us-east-1-1.aws.cloud2.influxdata.com';
const token = 'x5MZQdYA2jGPv4Qmuyc18m_t3mjzNl8wDiz6ahuKOjOiNIRieHLClWYlL5CfNWzhQUBJLY_ux0K91Rt5498o_g==';
const org = 'littletree';
const bucket = 'farm_data';

const client = new InfluxDB({ url, token });
const queryApi = client.getQueryApi(org);

// ==========================================
// 2. ตั้งค่า MQTT (เชื่อมต่อบอร์ด ESP32)
// ==========================================
let realPumpStatus = 'OFF'; // ตัวแปรจำสถานะปั๊มจริง
let realAutoStatus = 'OFF'; // ตัวแปรจำสถานะออโต้จริง

const mqttClient = mqtt.connect('ws://broker.hivemq.com:8000/mqtt');
const mqttTopic = 'SmartFarm/Pump2/Control';
const mqttTopicStatus = 'SmartFarm/Pump2/Status';

mqttClient.on('connect', () => {
    console.log('✅ เชื่อมต่อ MQTT สำเร็จ');
    mqttClient.subscribe(mqttTopicStatus); // ดักฟังเสียงตอบกลับจากบอร์ด
});

// เมื่อบอร์ดตะโกนสถานะกลับมา ให้เซฟเก็บไว้
mqttClient.on('message', (topic, message) => {
    if (topic === mqttTopicStatus) {
        const msg = message.toString();
        if (msg.startsWith('PUMP:')) realPumpStatus = msg.split(':')[1];
        if (msg.startsWith('AUTO:')) realAutoStatus = msg.split(':')[1];
    }
});

// ==========================================
// 3. API ROUTES (ช่องทางให้หน้าเว็บดึงข้อมูล)
// ==========================================

// 3.1 API ดึงค่าเซนเซอร์ปัจจุบัน (สำหรับโชว์เกจ)
app.get('/api/sensors', async (req, res) => {
    const fluxQuery = `
        from(bucket: "${bucket}")
        |> range(start: -1h)
        |> filter(fn: (r) => r["_measurement"] == "rain_sensor" or r["_measurement"] == "soil_sensor" or r["_measurement"] == "ec_sensor")
        |> filter(fn: (r) => r["_field"] == "value")
        |> last()
    `;
    try {
        const results = [];
        for await (const {values, tableMeta} of queryApi.iterateRows(fluxQuery)) {
            const o = tableMeta.toObject(values);
            results.push({ sensor: o._measurement, value: o._value });
        }
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'ดึงข้อมูลไม่สำเร็จ' });
    }
});

// 3.2 API ดึงข้อมูลย้อนหลัง 24 ชั่วโมง (สำหรับวาดกราฟเส้น)
app.get('/api/history', async (req, res) => {
    const fluxQueryHistory = `
        from(bucket: "${bucket}")
        |> range(start: -24h)
        |> filter(fn: (r) => r["_measurement"] == "rain_sensor" or r["_measurement"] == "soil_sensor" or r["_measurement"] == "ec_sensor")
        |> filter(fn: (r) => r["_field"] == "value")
        |> aggregateWindow(every: 1m, fn: mean, createEmpty: false)
        |> yield(name: "mean")
    `;
    try {
        const results = { rain: [], soil: [], ec: [] };
        for await (const {values, tableMeta} of queryApi.iterateRows(fluxQueryHistory)) {
            const o = tableMeta.toObject(values);
            if (o._measurement === 'rain_sensor') results.rain.push({ x: o._time, y: o._value });
            if (o._measurement === 'soil_sensor') results.soil.push({ x: o._time, y: o._value });
            if (o._measurement === 'ec_sensor') results.ec.push({ x: o._time, y: o._value });
        }
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'ดึงข้อมูลประวัติไม่สำเร็จ' });
    }
});

// 3.3 API สั่งเปิด-ปิดปั๊มน้ำ
app.post('/api/pump', (req, res) => {
    const { command } = req.body; 
    if (['ON', 'OFF', 'AUTO'].includes(command)) {
        mqttClient.publish(mqttTopic, command);
        res.json({ success: true, message: `ส่งคำสั่ง ${command} สำเร็จ` });
    } else {
        res.status(400).json({ success: false, message: 'คำสั่งไม่ถูกต้อง' });
    }
});

// 3.4 API สำหรับเช็คสถานะการทำงานจริงของบอร์ด
app.get('/api/pump/status', (req, res) => {
    res.json({ pump: realPumpStatus, auto: realAutoStatus });
});

// 3.5 API Export ข้อมูลเป็น CSV (สำหรับนำไปลง Google Sheets / Excel)
app.get('/api/csv', async (req, res) => {
    const fluxQueryCSV = `
        from(bucket: "${bucket}")
        |> range(start: -24h) // ดึงย้อนหลัง 24 ชม.
        |> filter(fn: (r) => r["_measurement"] == "rain_sensor" or r["_measurement"] == "soil_sensor" or r["_measurement"] == "ec_sensor")
        |> filter(fn: (r) => r["_field"] == "value")
        |> aggregateWindow(every: 15m, fn: mean, createEmpty: false) // หาค่าเฉลี่ยทุกๆ 15 นาที
        |> pivot(rowKey:["_time"], columnKey: ["_measurement"], valueColumn: "_value")
    `;

    try {
        let csvString = "Date-time,Rain(%),Soil Moisture(%),EC(%)\n";

        for await (const {values, tableMeta} of queryApi.iterateRows(fluxQueryCSV)) {
            const o = tableMeta.toObject(values);
            
            // สร้าง Date Object และบวกเวลาให้เป็นโซนไทย (UTC+7)
            const d = new Date(o._time);
            d.setHours(d.getHours() + 7);

            // บังคับฟอร์แมตเป็น YYYY-MM-DD HH:mm:ss 
            const year = d.getUTCFullYear();
            const month = String(d.getUTCMonth() + 1).padStart(2, '0');
            const day = String(d.getUTCDate()).padStart(2, '0');
            const hours = String(d.getUTCHours()).padStart(2, '0');
            const minutes = String(d.getUTCMinutes()).padStart(2, '0');
            const seconds = String(d.getUTCSeconds()).padStart(2, '0');
            
            const time = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            
            // ดึงค่ามาปัดเศษ (ถ้าไม่มีค่าให้เป็น 0)
            const rain = o.rain_sensor ? Math.round(o.rain_sensor) : 0;
            const soil = o.soil_sensor ? Math.round(o.soil_sensor) : 0;
            const ec = o.ec_sensor ? Math.round(o.ec_sensor) : 0;

            csvString += `"${time}",${rain},${soil},${ec}\n`;
        }

        res.header('Content-Type', 'text/csv; charset=utf-8');
        res.attachment('farm_data_report.csv');
        res.send(csvString);

    } catch (error) {
        console.error('CSV Error:', error);
        res.status(500).send("เกิดข้อผิดพลาดในการดึงไฟล์ CSV");
    }
});

// ==========================================
// 4. เริ่มเปิดเซิร์ฟเวอร์รัน
// ==========================================
app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});