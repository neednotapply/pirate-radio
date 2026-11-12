/* Pirate Radio: Bluetooth's assigned numbers, for the Bluetooth page.

   Who a company number is (the number that leads an advertisement's
   manufacturer data), what a service's number means, and what an
   appearance value says a device is. Made by scripts/bt-names.py, not by
   hand, from Nordic Semiconductor's bluetooth-numbers-database
   (https://github.com/NordicSemiconductor/bluetooth-numbers-database) as
   it was on 2026-11-12: 4021 companies, 129 services, 302 appearances. The few
   services listed under MEMBERS are added there by hand. The database's
   licence:

   Copyright (c) 2019 - 2020, Nordic Semiconductor ASA
   All rights reserved.

   Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

   1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

   2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

   3. Neither the name of Nordic Semiconductor ASA nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY, AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BELIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
(function (root) {
	"use strict";

	// A company's name, on the line of its number (the first line: number 0)
	var COMPANIES = `Ericsson AB
Nokia Mobile Phones
Intel Corp.
IBM Corp.
Toshiba Corp.
3Com
Microsoft
Lucent
Motorola
Infineon Technologies AG
Qualcomm Technologies International, Ltd. (QTIL)
Silicon Wave
Digianswer A/S
Texas Instruments Inc.
Parthus Technologies Inc.
Broadcom Corporation
Mitel Semiconductor
Widcomm, Inc.
Zeevo, Inc.
Atmel Corporation
Mitsubishi Electric Corporation
RTX A/S
KC Technology Inc.
Newlogic
Transilica, Inc.
Rohde & Schwarz GmbH & Co. KG
TTPCom Limited
Signia Technologies, Inc.
Conexant Systems Inc.
Qualcomm
Inventel
AVM Berlin
BandSpeed, Inc.
Mansella Ltd
NEC Corporation
WavePlus Technology Co., Ltd.
Alcatel
NXP B.V.
C Technologies
Open Interface
R F Micro Devices
Hitachi Ltd
Symbol Technologies, Inc.
Tenovis
Macronix International Co. Ltd.
GCT Semiconductor
Norwood Systems
MewTel Technology Inc.
ST Microelectronics
Synopsys, Inc.
Red-M (Communications) Ltd
Commil Ltd
Computer Access Technology Corporation (CATC)

Renesas Electronics Corporation
Mobilian Corporation
Syntronix Corporation
Integrated System Solution Corp.
Panasonic Holdings Corporation
Gennum Corporation
BlackBerry Limited
IPextreme, Inc.
Systems and Chips, Inc
Bluetooth SIG, Inc
Seiko Epson Corporation
Integrated Silicon Solution Taiwan, Inc.
CONWISE Technology Corporation Ltd
PARROT AUTOMOTIVE SAS
Socket Mobile
Atheros Communications, Inc.
MediaTek, Inc.
Bluegiga
Marvell Technology Group Ltd.
3DSP Corporation
Accel Semiconductor Ltd.
AUMOVIO Systems, Inc.
Apple, Inc.
Staccato Communications, Inc.
Avago Technologies
APT Ltd.
SiRF Technology, Inc.
Tzero Technologies, Inc.
J&M Corporation
Free2move AB
3DiJoy Corporation
Plantronics, Inc.
Sony Ericsson Mobile Communications
Harman International Industries, Inc.
Vizio, Inc.
Nordic Semiconductor ASA
EM Microelectronic-Marin SA
Ralink Technology Corporation
Belkin International, Inc.
Realtek Semiconductor Corporation
Stonestreet One, LLC
Wicentric, Inc.
RivieraWaves S.A.S
RDA Microelectronics
Gibson Guitars
MiCommand Inc.
Band XI International, LLC
HP, Inc.

GN Hearing
General Motors
A&D Engineering, Inc.
LTM Limited
Polar Electro OY
Beautiful Enterprise Co., Ltd.

Summit Data Communications, Inc.
Sound ID
Monster, LLC
connectBlue AB
ShangHai Super Smart Electronics Co. Ltd.
Group Sense Ltd.
Zomm, LLC
Samsung Electronics Co. Ltd.
Creative Technology Ltd.
Laird Connectivity LLC
Nike, Inc.
lesswire AG
MStar Semiconductor, Inc.
Hanlynn Technologies

Seers Technology Co., Ltd.

Autonet Mobile
DeLorme Publishing Company, Inc.
WuXi Vimicro
DSEA A/S
TimeKeeping Systems, Inc.
Ludus Helsinki Ltd.
BlueRadios, Inc.
Equinux AG
Garmin International, Inc.

GN Hearing A/S
Jawbone
Topcon Positioning Systems, LLC
Gimbal Inc.
Zscan Software
Quintic Corp
Telit Wireless Solutions GmbH
Funai Electric Co., Ltd.
Advanced PANMOBIL systems GmbH & Co. KG
ThinkOptics, Inc.
Universal Electronics, Inc.
Airoha Technology Corp.
NEC Lighting, Ltd.
ODM Technology, Inc.
ConnecteDevice Ltd.
zero1.tv GmbH
i.Tech Dynamic Global Distribution Ltd.
Alpwise
Jiangsu Toppower Automotive Electronics Co., Ltd.
Colorfy, Inc.
Geoforce Inc.
Bose Corporation
Suunto Oy
Kensington Computer Products Group
SR-Medizinelektronik
Vertu Corporation Limited
Meta Watch Ltd.
LINAK A/S
OTL Dynamics LLC
Panda Ocean Inc.
Visteon Corporation
ARP Devices Limited
MARELLI EUROPE S.P.A.
CAEN RFID srl
Ingenieur-Systemgruppe Zahn GmbH
Green Throttle Games
Peter Systemtechnik GmbH
Omegawave Oy
Cinetix
Passif Semiconductor Corp
Saris Cycling Group, Inc
Bekey A/S
Clarinox Technologies Pty. Ltd.
BDE Technology Co., Ltd.
Swirl Networks
Meso international
TreLab Ltd
Qualcomm Innovation Center, Inc. (QuIC)
Johnson Controls, Inc.
Starkey Hearing Technologies
S-Power Electronics Limited
Ace Sensor Inc
Aplix Corporation
AAMP of America
Stalmart Technology Limited
AMICCOM Electronics Corporation
Shenzhen Excelsecu Data Technology Co.,Ltd
Geneq Inc.
adidas AG
LG Electronics
Onset Computer Corporation
Selfly BV
Quuppa Oy.
GeLo Inc
Evluma
MC10
Binauric SE
Beats Electronics
Microchip Technology Inc.
Eve Systems GmbH
ARCHOS SA
Dexcom, Inc.
Polar Electro Europe B.V.
Renesas Design Netherlands B.V.
Taixingbang Technology (HK) Co,. LTD.

Austco Communication Systems
Timex Group USA, Inc.
Qualcomm Technologies, Inc.
Qualcomm Connected Experiences, Inc.
Voyetra Turtle Beach
txtr GmbH
Snuza (Pty) Ltd
Procter & Gamble
Hosiden Corporation
Muzik LLC
Misfit Wearables Corp
Google
Danlers Ltd
Semilink Inc
inMusic Brands, Inc
L.S. Research, Inc.
Eden Software Consultants Ltd.

KS Technologies
ACTS Technologies
Vtrack Systems
Nielsen-Kellerman
Server Technology Inc.
BioResearch Associates
Jolly Logic, LLC
Above Average Outcomes, Inc.
Bitsplitters GmbH
PayPal, Inc.
Witron Technology Limited
Morse Project Inc.
Kent Displays Inc.
Nautilus Inc.
Smartifier Oy

VSN Technologies, Inc.
AceUni Corp., Ltd.

Crystal Alarm AB
KOUKAAM a.s.
Delphi Corporation
ValenceTech Limited
Stanley Black and Decker
Typo Products, LLC
TomTom International BV
Fugoo, Inc.
Keiser Corporation
Bang & Olufsen A/S
PLUS Location Systems Pty Ltd
Ubiquitous Computing Technology Corporation
Innovative Yachtter Solutions
Demant A/S
Chicony Electronics Co., Ltd.
Atus BV
Codegate Ltd
ERi, Inc
Transducers Direct, LLC
DENSO TEN Limited
Audi AG
HiSilicon Technologies CO., LIMITED
Nippon Seiki Co., Ltd.
Steelseries ApS
Visybl Inc.
Openbrain Technologies, Co., Ltd.

e.solutions
10AK Technologies
Wimoto Technologies Inc
Radius Networks, Inc.

Qualcomm Labs, Inc.
Hewlett Packard Enterprise
Baidu
Arendi AG
Skoda Auto a.s.
Volkswagen AG
Porsche AG
Sino Wealth Electronic Ltd.
AirTurn, Inc.
Kinsa, Inc
HID Global
SEAT es
Promethean Ltd.
Salutica Allied Solutions
GPSI Group Pty Ltd
Nimble Devices Oy
Changzhou Yongse Infotech Co., Ltd.
SportIQ
TEMEC Instruments B.V.
Sony Corporation
ASSA ABLOY
Clarion Co. Inc.
Warehouse Innovations
Cypress Semiconductor
MADS Inc
Blue Maestro Limited
Resolution Products, Ltd.
Aireware LLC
Silvair, Inc.
Prestigio Plaza Ltd.
NTEO Inc.
Focus Systems Corporation
Tencent Holdings Ltd.
Allegion
Murata Manufacturing Co., Ltd.
WirelessWERX
Nod, Inc.

Alpine Electronics (China) Co., Ltd
FedEx Services
Grape Systems Inc.
Bkon Connect
Lintech GmbH
Novatel Wireless
Ciright
Mighty Cast, Inc.
Ambimat Electronics
Perytons Ltd.
Tivoli Audio, LLC
Master Lock
Mesh-Net Ltd
HUIZHOU DESAY SV AUTOMOTIVE CO., LTD.
Tangerine, Inc.
B&W Group Ltd.
Pioneer Corporation
OnBeep
Vernier Software & Technology
ROL Ergo
Pebble Technology
NETATMO
Accumulate AB
Anhui Huami Information Technology Co., Ltd.
Inmite s.r.o.
ChefSteps, Inc.
micas AG
Biomedical Research Ltd.
Pitius Tec S.L.
Estimote, Inc.
Unikey Technologies, Inc.
Timer Cap Co.
AwoX
yikes
MADSGlobalNZ Ltd.
PCH International
Qingdao Yeelink Information Technology Co., Ltd.
Milwaukee Electric Tools
MISHIK Pte Ltd
Ascensia Diabetes Care US Inc.
Spicebox LLC
emberlight
Copeland Cold Chain LP
Qblinks
MYSPHERA
LifeScan Inc
Volantic AB
Podo Labs, Inc
Roche Diabetes Care AG
Amazon.com Services LLC
Connovate Technology Private Limited
Kocomojo, LLC
Everykey Inc.
Dynamic Controls
SentriLock
I-SYST inc.
CASIO COMPUTER CO., LTD.
LAPIS Semiconductor Co.,Ltd
Telemonitor, Inc.
taskit GmbH
Mercedes-Benz Group AG
BatAndCat
BluDotz Ltd
XTel Wireless ApS
Gigaset Technologies GmbH
Gecko Health Innovations, Inc.

Walt Disney
Nectar


Seraphim Sense Ltd
Unico RBC
Physical Enterprises Inc.
Able Trend Technology Limited
Konica Minolta, Inc.
Wilo SE
Extron Design Services
Google LLC

Intelletto Technologies Inc.
FDK CORPORATION
Cloudleaf, Inc
Maveric Automation LLC
Acoustic Stream Corporation
Zuli
Paxton Access Ltd
WiSilica Inc.
VENGIT Korlatolt Felelossegu Tarsasag
SALTO SYSTEMS S.L.
TRON Forum
CUBETECH s.r.o.
Cokiya Incorporated
CVS Health
Ceruus
Strainstall Ltd
Channel Enterprises (HK) Ltd.
FIAMM
GIGALANE.CO.,LTD

MSA Innovation, LLC
Icon Health and Fitness
Wille Engineering
ENERGOUS CORPORATION
Taobao
Canon Inc.
Geophysical Technology Inc.
Meta Platforms, Inc.
Trividia Health, Inc.
FlightSafety International

Sunrise Micro Devices, Inc.
Star Micronics Co., Ltd.
Netizens Sp. z o.o.
Nymi Inc.
Nytec, Inc.
Trineo Sp. z o.o.
Nest Labs Inc.
LM Technologies Ltd
General Electric Company
i+D3 S.L.
HANA Micron
SPIA Cycling Inc.
Cochlear Bone Anchored Solutions AB
SenionLab AB
Syszone Co., Ltd
Pulsate Mobile Ltd.
Hongkong OnMicro Electronics Limited

BRADATECH Corp.
Transenergooil AG

DME Microelectronics
Bitcraze AB
HASWARE Inc.
Abiogenix Inc.
Poly-Control ApS
Avi-on
Laerdal Medical AS
Fetch My Pet
Sam Labs Ltd.
Chengdu Synwing Technology Ltd
HOUWA SYSTEM DESIGN, k.k.
BSH
Primus Inter Pares Ltd
August Home, Inc
Gill Electronics
Sky Wave Design
Newlab S.r.l.
ELAD srl
G-wearables inc.

Code Corporation
Savant Systems LLC
Logitech International SA
Innblue Consulting

Koninklijke Philips N.V.
Minelab Electronics Pty Limited
Bison Group Ltd.
WS Audiology Denmark A/S
Jolla Ltd

Caterpillar Inc
Freedom Innovations
Dynamic Devices Ltd
Technology Solutions (UK) Ltd



Advanced Application Design, Inc.

Spreadtrum Communications Shanghai Ltd

Valeo Service
Fullpower Technologies, Inc.
KloudNation
Zebra Technologies Corporation
Itron, Inc.
The University of Tokyo
UTC Fire and Security
Cool Webthings Limited
DJO Global
Gelliner Limited
Anyka (Guangzhou) Microelectronics Technology Co, LTD
Medtronic Inc.
Gozio Inc.
Form Lifting, LLC
Wahoo Fitness, LLC
Kontakt Micro-Location Sp. z o.o.
Radio Systems Corporation
Freescale Semiconductor, Inc.
Verifone Systems Pte Ltd. Taiwan Branch
AR Timing
Rigado LLC
Kemppi Oy


Otter Products, LLC
STEMP Inc.
LumiGeek LLC
InvisionHeart Inc.
Macnica Inc.
Jaguar Land Rover Limited
CoroWare Technologies, Inc

Omron Healthcare Co., LTD
Comodule GMBH
ikeGPS
Telink Semiconductor Co. Ltd
Interplan Co., Ltd
Wyler AG
IK Multimedia Production srl
Lukoton Experience Oy
MTI Ltd
Tech4home, Lda

DOTT Limited
Blue Speck Labs, LLC
Cisco Systems, Inc
Mobicomm Inc
Edamic
Goodnet, Ltd
Luster Leaf Products Inc
Manus Machina BV
Mobiquity Networks Inc
Praxis Dynamics
Philip Morris Products S.A.
Comarch SA
Nestlé Nespresso S.A.
Merlinia A/S
LifeBEAM Technologies
Twocanoes Labs, LLC
Muoverti Limited
Stamer Musikanlagen GMBH
Tesla, Inc.
Pharynks Corporation
Lupine
Siemens AG

Foster Electric Company, Ltd
ETA SA
x-Senso Solutions Kft

FengFan (BeiJing) Technology Co, Ltd
Qrio Inc
Pitpatpet Ltd
MSHeli s.r.l.
Trakm8 Ltd
JIN CO, Ltd
Alatech Tehnology
Beijing CarePulse Electronic Technology Co, Ltd

ViCentra B.V.
Raven Industries
WaveWare Technologies Inc.
Argenox Technologies
Bragi GmbH

Masimo Corp
Iotera Inc
Endress+Hauser
ACKme Networks, Inc.
FiftyThree Inc.
Parker Hannifin Corp

Uwatec AG
Orlan LLC
Blue Clover Devices
M-Way Solutions GmbH
Microtronics Engineering GmbH
Schneider Schreibgeräte GmbH
Sapphire Circuits LLC
Lumo Bodytech Inc.
Restar Corporation
Xicato Inc.
Playbrush
Dai Nippon Printing Co., Ltd.
G24 Power Limited
AdBabble Local Commerce Inc.
Devialet SA
ALTYOR
University of Applied Sciences Valais/Haute Ecole Valaisanne
Five Interactive, LLC dba Zendo
NetEase（Hangzhou）Network co.Ltd.
Lexmark International Inc.
Fluke Corporation
Yardarm Technologies

SECVRE GmbH
Glacial Ridge Technologies

DDS, Inc.
SMK Corporation
Schawbel Technologies LLC
XMI Systems SA
Cerevo
Torrox GmbH & Co KG
Gemalto
DEKA Research & Development Corp.
Domster Tadeusz Szydlowski
Technogym SPA
FLEURBAEY BVBA
Aptcode Solutions
LSI ADL Technology
Animas Corp
Alps Alpine Co., Ltd.
OCEASOFT
Motsai Research
Geotab
E.G.O. Elektro-Geraetebau GmbH
bewhere inc
Johnson Outdoors Inc
steute Schaltgerate GmbH & Co. KG
Ekomini inc.
DEFA AS
Aseptika Ltd
HUAWEI Technologies Co., Ltd.
HabitAware, LLC
ruwido austria gmbh
ITEC corporation
StoneL
Sonova AG
Maven Machines, Inc.
Synapse Electronics
WOWTech Canada Ltd.
RF Code, Inc.
Wally Ventures S.L.

SK Telecom
Jetro AS
Code Gears LTD
NANOLINK APS

RF Digital Corp
Church & Dwight Co., Inc
Multibit Oy
CliniCloud Inc

Blue Bite
ELIAS GmbH
Sivantos GmbH
Petzl
storm power ltd
EISST Ltd
Inexess Technology Simma KG
Currant, Inc.
C2 Development, Inc.
Blue Sky Scientific, LLC
ALOTTAZS LABS, LLC
Kupson spol. s r.o.
Areus Engineering GmbH
Impossible Camera GmbH

Sera4 Ltd.
Itude
Pacific Lock Company
Tendyron Corporation
Robert Bosch GmbH
Illuxtron international B.V.
miSport Ltd.
Chargelib
Doppler Lab
BBPOS Limited

Rx Networks, Inc.
WeatherFlow, Inc.
Technicolor USA Inc.
Bestechnic(Shanghai),Ltd
Raden Inc
Oura Health Oy
CLABER S.P.A.
Hyginex, Inc.
HANSHIN ELECTRIC RAILWAY CO.,LTD.
Schneider Electric
Oort Technologies LLC
Chrono Therapeutics
Rinnai Corporation
Swissprime Technologies AG
YOKOWO CO., LTD.
Genevac Ltd
Chemtronics
Seguro Technology Sp. z o.o.

Dash Robotics
LINE Corporation
Guillemot Corporation
Techtronic Power Tools Technology Limited
Wilson Sporting Goods
Lenovo (Singapore) Pte Ltd.
Ayatan Sensors
Electronics Tomorrow Limited
OneSpan
PayRange Inc.
ABOV Semiconductor
AINA-Wireless Inc.

BMA ergonomics b.v.
Teva Branded Pharmaceutical Products R&D, Inc.
Anima
3M
Empatica Srl
Afero, Inc.
Powercast Corporation
Secuyou ApS
OMRON Corporation
Send Solutions
NIPPON SYSTEMWARE CO.,LTD.
Neosfar
Fliegl Agrartechnik GmbH
Gilvader
Digi International Inc (R)
DeWalch Technologies, Inc.
Flint Rehabilitation Devices, LLC
Samsung SDS Co., Ltd.
Blur Product Development
University of Michigan
Victron Energy BV
NTT docomo
Carmanah Technologies Corp.
Bytestorm Ltd.
Espressif Systems (Shanghai) Co., Ltd.
Unwire
Connected Yard, Inc.
American Music Environments
Sensogram Technologies, Inc.
Fujitsu Limited
Ardic Technology

HTC Corporation
Citizen Holdings Co., Ltd.
SMART-INNOVATION.inc
Blackrat Software
The Idea Cave, LLC
GoPro, Inc.
AuthAir, Inc
Vensi, Inc.
Indagem Tech LLC
Intemo Technologies

Runteq Oy Ltd
IMAGINATION TECHNOLOGIES LTD

Clarius Mobile Health Corp.
Shanghai Frequen Microelectronics Co., Ltd.

Lierda Science & Technology Group Co., Ltd.
Silicon Laboratories
World Moto Inc.
Giatec Scientific Inc.
Loop Devices, Inc
IACA electronique
Oura Health Ltd
Swipp ApS
Life Laboratory Inc.
FUJI INDUSTRIAL CO.,LTD.
Surefire, LLC
Dolby Labs
Ellisys
Magnitude Lighting Converters
Hilti AG
Devdata S.r.l.

Shortcut Labs
SGL Italia S.r.l.
PEEQ DATA
Ducere Technologies Pvt Ltd
DiveNav, Inc.
RIIG AI Sp. z o.o.
Thermo Fisher Scientific
AG Measurematics Pvt. Ltd.
CHUO Electronics CO., LTD.
Aspenta International
Eugster Frismag AG
Wurth Elektronik eiSos GmbH & Co. KG
HQ Inc
Lab Sensor Solutions
Enterlab ApS
Eyefi, Inc.
MetaSystem S.p.A.
SONO ELECTRONICS. CO., LTD


Rotor Bike Components
Astro, Inc.

Healthwear Technologies (Changzhou)Ltd
Essex Electronics
Grundfos A/S
Eargo, Inc.
Electronic Design Lab
ESYLUX
NIPPON SMT.CO.,Ltd
BM innovations GmbH
indoormap
OttoQ Inc
North Pole Engineering
3flares Technologies Inc.

Mul-T-Lock
Airthings ASA
Enlighted Inc
GISTIC
AJP2 Holdings, LLC
COBI GmbH
Blue Sky Scientific, LLC
Appception, Inc.
Courtney Thorne Limited

TPV Technology Limited
Monitra SA
Automation Components, Inc.

Etesian Technologies LLC
GERTEC BRASIL LTDA.
Drekker Development Pty. Ltd.
Whirl Inc
Locus Positioning
Acuity Brands Lighting, Inc
Prevent Biometrics

VersaMe

Libratone A/S
HM Electronics, Inc.
TASER International, Inc.

Heartland Payment Systems
Bitstrata Systems Inc.
Pieps GmbH
iRiding(Xiamen)Technology Co.,Ltd.
Alpha Audiotronics, Inc.
TOPPAN, Inc.
Sigma Designs, Inc.
Spectrum Brands, Inc.
Polymap Wireless
MagniWare Ltd.
Novotec Medical GmbH
Phillips-Medisize A/S
Matrix Inc.
Eaton Corporation
KYS
Naya Health, Inc.
Acromag
Insulet Corporation
Wellinks Inc.
ON Semiconductor
FREELAP SA
Favero Electronics Srl
BioMech Sensor LLC
BOLTT Sports technologies Private limited

Metormote AB
littleBits
SetPoint Medical
BRControls Products BV
Zipcar
AirBolt Pty Ltd
MOTIVE TECHNOLOGIES, INC.
Motiv, Inc.
Wazombi Labs OÜ

Nixie Labs, Inc.
AppNearMe Ltd
Holman Industries
Expain AS
Electronic Temperature Instruments Ltd
Plejd AB
Propeller Health
Shenzhen iMCO Electronic Technology Co.,Ltd
Algoria
Apption Labs Inc.
Cronologics Corporation
MICRODIA Ltd.
lulabytes S.L.
Société des Produits Nestlé S.A.
LLC "MEGA-F service"
Sharp Corporation
Precision Outcomes Ltd
Kronos Incorporated

Embedded Electronic Solutions Ltd. dba e2Solutions
Aterica Inc.
BluStor PMC, Inc.
Kapsch TrafficCom AB
ActiveBlu Corporation
Kohler Mira Limited
Noke
Appion Inc.
Resmed Ltd
Crownstone B.V.
Xiaomi Inc.
INFOTECH s.r.o.
Thingsquare AB
T&D
LAVAZZA S.p.A.

SDATAWAY
BLOKS GmbH
LEGO System A/S
Thetatronics Ltd
Nikon Corporation
NeST
South Silicon Valley Microelectronics
ALE International
CareView Communications, Inc.
SchoolBoard Limited
Molex Corporation
IVT Wireless Limited
Alpine Labs LLC
Candura Instruments
SmartMovt Technology Co., Ltd
Token Zero Ltd
ACE CAD Enterprise Co., Ltd. (ACECAD)
Medela, Inc
AeroScout
Esrille Inc.

Exon Sp. z o.o.
Meizu Technology Co., Ltd.

XiQ
Allswell Inc.
Comm-N-Sense Corp DBA Verigo
VIBRADORM GmbH
Otodata Wireless Network Inc.
Propagation Systems Limited
Midwest Instruments & Controls
Alpha Nodus, inc.
petPOMM, Inc
Mattel
Airbly Inc.
A-Safe Limited
FREDERIQUE CONSTANT SA
Maxscend Microelectronics Company Limited
Abbott
ASB Bank Ltd
amadas
Applied Science, Inc.
iLumi Solutions Inc.
Arch Systems Inc.
Ember Technologies, Inc.
Snapchat Inc
Casambi Technologies Oy
Pico Technology Inc.
St. Jude Medical, Inc.
Intricon
Structural Health Systems, Inc.
Avvel International
Gallagher Group
In2things Automation Pvt. Ltd.
SYSDEV Srl
Vonkil Technologies Ltd
Wynd Technologies, Inc.
CONTRINEX S.A.
MIRA, Inc.
Watteam Ltd
Density Inc.
IOT Pot India Private Limited
Sigma Connectivity AB
PEG PEREGO SPA
Wyzelink Systems Inc.
Yota Devices LTD
FINSECUR
Zen-Me Labs Ltd
3IWare Co., Ltd.
EnOcean GmbH
Instabeat, Inc
Nima Labs
Andreas Stihl AG & Co. KG
Nathan Rhoades LLC
Grob Technologies, LLC
Actions Technology Co.,Ltd
SPD Development Company Ltd
Sensoan Oy
Qualcomm Life Inc
Chip-ing AG
ffly4u
IoT Instruments Oy
TRUE Fitness Technology

SHENZHEN LEMONJOY TECHNOLOGY CO., LTD.
Hello Inc.
Ozo Edu, Inc.
Jigowatts Inc.
BASIC MICRO.COM,INC.
CUBE TECHNOLOGIES

CLINK
Hestan Smart Cooking Inc.
WindowMaster A/S

PAL Technologies Ltd
WHERE, Inc.
Iton Technology Corp.
Owl Labs Inc.
Rockford Corp.
Becon Technologies Co.,Ltd.
Vyassoft Technologies Inc
Nox Medical
Kimberly-Clark
Trimble Inc.
Littelfuse
Withings
i-developer IT Beratung UG
Relations Inc.
Sears Holdings Corporation
Gantner Electronic GmbH
Authomate Inc
Vertex International, Inc.

Swiss Audio SA
ToGetHome Inc.

ZF OPENMATICS s.r.o.
Jana Care Inc.

NorthStar Battery Company, LLC
SKF (U.K.) Limited
CO-AX Technology, Inc.
Fender Musical Instruments
Luidia Inc
SEFAM
Wireless Cables Inc


SODA GmbH
Fatigue Science

Novalogy LTD
Friday Labs Limited
OrthoAccel Technologies
WaterGuru, Inc.
Benning Elektrotechnik und Elektronik GmbH & Co. KG
Dell Computer Corporation
Kopin Corporation
TecBakery GmbH
Backbone Labs, Inc.
DELSEY SA
Chargifi Limited
Trainesense Ltd.
Unify Software and Solutions GmbH & Co. KG
Husqvarna AB
Focus fleet and fuel management inc
SmallLoop, LLC
Prolon Inc.
BD Medical
iMicroMed Incorporated
Ticto N.V.
Meshtech AS
MemCachier Inc.
Danfoss A/S
SnapStyk Inc.
Alticor Inc.
Silk Labs, Inc.
Pillsy Inc.
Hatch Baby, Inc.
Blocks Wearables Ltd.
Drayson Technologies (Europe) Limited
eBest IOT Inc.
Helvar Ltd
Radiance Technologies
Nuheara Limited
Appside co., ltd.

Coiler Corporation
Thermomedics, Inc.
Tentacle Sync GmbH
Valencell, Inc.

SECOM CO., LTD.
Tucker International LLC
Metanate Limited
Kobian Canada Inc.
NETGEAR, Inc.
Fabtronics Australia Pty Ltd
Grand Centrix GmbH
1UP USA.com llc
SHIMANO INC.
Nain Inc.
LifeStyle Lock, LLC
VEGA Grieshaber KG
Xtrava Inc.
TTS Tooltechnic Systems AG & Co. KG
Teenage Engineering AB
Tunstall Nordic AB
Svep Design Center AB
Qorvo Utrecht B.V.
Sphinx Electronics GmbH & Co KG

Nemik Consulting Inc
RF INNOVATION
Mini Solution Co., Ltd.

2048450 Ontario Inc

Delta T Corporation
Boston Scientific Corporation
Nuviz, Inc.
Real Time Automation, Inc.
Kolibree
vhf elektronik GmbH
Bonsai Systems GmbH
Fathom Systems Inc.
Bellman & Symfon Group AB
International Forte Group LLC

Codenex Oy
Kynesim Ltd
Palago AB
INSIGMA INC.
PMD Solutions
Qingdao Realtime Technology Co., Ltd.
BEGA Gantenbrink-Leuchten KG
Pambor Ltd.
Develco Products A/S
iDesign s.r.l.
TiVo Corp
Control-J Pty Ltd
Steelcase, Inc.
iApartment co., ltd.
Icom inc.

Blue Spark Technologies
FarSite Communications Limited
mywerk system GmbH
Sinosun Technology Co., Ltd.
MIYOSHI ELECTRONICS CORPORATION

Occly LLC
OurHub Dev IvS
Pro-Mark, Inc.

Quintrax Limited
POS Tuning Udo Vosshenrich GmbH & Co. KG

Revol Technologies Inc
SKIDATA AG
DEV TECNOLOGIA INDUSTRIA, COMERCIO E MANUTENCAO DE EQUIPAMENTOS LTDA. - ME
Centrica Connected Home
Automotive Data Solutions Inc
Igarashi Engineering
Taelek Oy

Vectronix AG
S-Labs Sp. z o.o.
Companion Medical, Inc.
BlueKitchen GmbH
Matting AB
SOREX - Wireless Solutions GmbH
ADC Technology, Inc.
Lynxemi Pte Ltd
SENNHEISER electronic GmbH & Co. KG

Polymorphic Labs LLC
Cochlear Limited
METER Group, Inc. USA
Ruuvi Innovations Ltd.
Situne AS
nVisti, LLC
DyOcean
Uhlmann & Zacher GmbH
AND!XOR LLC
Popper Pay AB


ovrEngineered, LLC
GT-tronics HK Ltd
Herbert Waldmann GmbH & Co. KG
Guangzhou FiiO Electronics Technology Co.,Ltd
Vinetech Co., Ltd
Dallas Logic Corporation
BioTex, Inc.

LINKIO SAS
Harbortronics, Inc.
Undagrid B.V.
Shure Inc
ERM Electronic Systems LTD
BIOROWER Handelsagentur GmbH

Kartographers Technologies Pvt. Ltd.
The Shadow on the Moon
mobike (Hong Kong) Limited
Inuheat Group AB
Swiftronix AB
Diagnoptics Technologies
Analog Devices, Inc.
Soraa Inc.
CSR Building Products Limited
Crestron Electronics, Inc.
Neatebox Ltd
Draegerwerk AG & Co. KGaA
AlbynMedical
Averos FZCO
VIT Initiative, LLC
Statsports International
Sospitas, s.r.o.
Dmet Products Corp.
Mantracourt Electronics Limited
TeAM Hutchins AB
Seibert Williams Glass, LLC
Insta GmbH
Svantek Sp. z o.o.
Shanghai Flyco Electrical Appliance Co., Ltd.
Thornwave Labs Inc
Steiner-Optik GmbH
Novo Nordisk A/S

Safetech Products LLC
GOOOLED S.R.L.
DOM Sicherheitstechnik GmbH & Co. KG
Olympus Corporation
KTS GmbH
Anloq Technologies Inc.
Queercon, Inc
TASKA PROSTHETICS LIMITED
Gooee Limited
LUGLOC LLC
Blincam, Inc.
FUJIFILM Corporation
RM Acquisition LLC
Franceschi Marina snc
Engineered Audio, LLC.
IOTTIVE (OPC) PRIVATE LIMITED
4MOD Technology
Lutron Electronics Co., Inc.
Emerson Electric Co.
Guardtec, Inc.
REACTEC LIMITED

Under Armour
Woodenshark
Avack Oy
Smart Solution Technology, Inc.

STABILO International
Busch Jaeger Elektro GmbH
Pacific Bioscience Laboratories, Inc
Bird Home Automation GmbH
Motorola Solutions

Auxivia
DaisyWorks, Inc
Kosi Limited
Theben AG
InDreamer Techsol Private Limited
Cerevast Medical
ZanCompute Inc.
Pirelli Tyre S.P.A.
McLear Limited
Shenzhen Goodix Technology Co., Ltd
Convergence Systems Limited
Interactio
Androtec GmbH
Benchmark Drives GmbH & Co. KG
SwingLync L. L. C.
Tapkey GmbH
Woosim Systems Inc.
Microsemi Corporation
Wiliot LTD.
Polaris IND
Specifi-Kali LLC
Locoroll, Inc
PHYPLUS Inc
InPlay, Inc.
Hager

Axes System sp. z o. o.
Garage Smart, Inc.
Shake-on B.V.
Vibrissa Inc.
OSRAM GmbH
TRSystems GmbH
Yichip Microelectronics (Hangzhou) Co.,Ltd.
Foundation Engineering LLC
UNI-ELECTRONICS, INC.
Brookfield Equinox LLC
Soprod SA
9974091 Canada Inc.
FIBRO GmbH
RB Controls Co., Ltd.
Footmarks
Amtronic Sverige AB
MAMORIO.inc
Tyto Life LLC
Leica Camera AG

EDPS
OFF Line Co., Ltd.
Detect Blue Limited
Setec Pty Ltd
Target Corporation
IAI Corporation
NS Tech, Inc.
MTG Co., Ltd.
Hangzhou iMagic Technology Co., Ltd
HONGKONG NANO IC TECHNOLOGIES CO., LIMITED
Honeywell International Inc.
Albrecht JUNG
Lunera Lighting Inc.
Lumen UAB
Keynes Controls Ltd
Novartis AG
Geosatis SA
EXFO, Inc.
LEDVANCE GmbH
Center ID Corp.
Adolene, Inc.
D&M Holdings Inc.
CRESCO Wireless, Inc.
Nura Operations Pty Ltd
Frontiergadget, Inc.
Smart Component Technologies Limited
ZTR Control Systems LLC
MetaLogics Corporation
Medela AG
OPPLE Lighting Co., Ltd
Savitech Corp.,
prodigy
Screenovate Technologies Ltd
TESA SA
CLIM8 LIMITED
Silergy Corp
SilverPlus, Inc
Sharknet srl
Mist Systems, Inc.
MIWA LOCK CO.,Ltd
OrthoSensor, Inc.

Apexar Technologies S.A.
LOGICDATA Electronic & Software Entwicklungs GmbH
Knick Elektronische Messgeraete GmbH & Co. KG
Smart Technologies and Investment Limited
Linough Inc.
Advanced Electronic Designs, Inc.
Carefree Scott Fetzer Co Inc
Sensome
FORTRONIK storitve d.o.o.
Sinnoz

Sylero
Avempace SARL
Nintendo Co., Ltd.
National Instruments
KROHNE Messtechnik GmbH
Otodynamics Ltd
Arwin Technology Limited
benegear, inc.
Newcon Optik
CANDY HOUSE, Inc.
FRANKLIN TECHNOLOGY INC
Lely
Valve Corporation
Hekatron Vertriebs GmbH
PROTECH S.A.S. DI GIRARDI ANDREA & C.
Sarita CareTech APS
Finder S.p.A.
Thalmic Labs Inc.
Steinel GmbH
Beghelli Spa

CORE TRANSPORT TECHNOLOGIES NZ LIMITED
Xiamen Everesports Goods Co., Ltd
Bodyport Inc.

Flipnavi Co.,Ltd.
Rion Co., Ltd.
Long Range Systems, LLC
Redmond Industrial Group LLC
VIZPIN INC.
BikeFinder AS
Consumer Sleep Solutions LLC
PSIKICK, INC.
AntTail.com
Lighting Science Group Corp.
AFFORDABLE ELECTRONICS INC
Integral Memroy Plc
Globalstar, Inc.
True Wearables, Inc.
Wellington Drive Technologies Ltd

OMNI Remotes
Duracell U.S. Operations Inc.
Toor Technologies LLC
Instinct Performance
Beco, Inc
Scuf Gaming International, LLC

LYS TECHNOLOGIES LTD
Breakwall Analytics, LLC
Code Blue Communications
Gira Giersiepen GmbH & Co. KG
Hearing Lab Technology
LEGRAND
Derichs GmbH
ALT-TEKNIK LLC
Star Technologies
START TODAY CO.,LTD.
Maxim Integrated Products
Fracarro Radioindustrie SRL
Jungheinrich Aktiengesellschaft
Meta Platforms Technologies, LLC
HENDON SEMICONDUCTORS PTY LTD
Pur3 Ltd
Viasat Group S.p.A.
IZITHERM
Spaulding Clinical Research
Kohler Company
Inor Process AB
My Smart Blinds
RadioPulse Inc
rapitag GmbH
Lazlo326, LLC.
Teledyne Lecroy, Inc.
Dataflow Systems Limited
Macrogiga Electronics
Tandem Diabetes Care
Polycom, Inc.
Fisher & Paykel Healthcare
Dream Devices Technologies Oy
Shanghai Xiaoyi Technology Co.,Ltd.
ADHERIUM(NZ) LIMITED
Axiomware Systems Incorporated
O. E. M. Controls, Inc.
Kiiroo BV
Telecon Mobile Limited
Sonos Inc
Tom Allebrandi Consulting
Monidor
Tramex Limited
Nofence AS
GoerTek Dynaudio Co., Ltd.
INIA
CARMATE MFG.CO.,LTD
OV LOOP, INC.
NewTec GmbH
Medallion Instrumentation Systems
CAREL INDUSTRIES S.P.A.
Parabit Systems, Inc.
White Horse Scientific ltd
verisilicon
Elecs Industry Co.,Ltd.
Beijing Pinecone Electronics Co.,Ltd.
Ambystoma Labs Inc.
Suzhou Pairlink Network Technology
igloohome
Oxford Metrics plc
Leviton Mfg. Co., Inc.
ULC Robotics Inc.

Real-World-Systems Corporation
Nalu Medical, Inc.
P.I.Engineering
Grote Industries
Runtime, Inc.
Codecoup sp. z o.o. sp. k.
SELVE GmbH & Co. KG

Lippert Components, INC
SOMFY SAS
TBS Electronics B.V.
MHL Custom Inc
LucentWear LLC
WATTS ELECTRONICS
RJ Brands LLC
V-ZUG Ltd
Biowatch SA
Anova Applied Electronics
Lindab AB
frogblue TECHNOLOGY GmbH
Acurable Limited
LAMPLIGHT Co., Ltd.
TEGAM, Inc.
Zhuhai Jieli technology Co.,Ltd
modum.io AG
Farm Jenny LLC
Toyo Electronics Corporation
Applied Neural Research Corp
Avid Identification Systems, Inc.
Petronics Inc.
essentim GmbH
QT Medical INC.
VIRTUALCLINIC.DIRECT LIMITED
Viper Design LLC
Human, Incorporated
stAPPtronics GmbH
Elemental Machines, Inc.
Taiyo Yuden Co., Ltd
INEO ENERGY& SYSTEMS
Motion Instruments Inc.
PressurePro
COWBOY
iconmobile GmbH
ACS-Control-System GmbH
Bayerische Motoren Werke AG
Gycom Svenska AB
Fuji Xerox Co., Ltd

SIKOM AS
beken
The Linux Foundation
Try and E CO.,LTD.
SeeScan
Clearity, LLC
GS TAG
DPTechnics
TRACMO, INC.
Anki Inc.
Hagleitner Hygiene International GmbH
Konami Sports Life Co., Ltd.
Arblet Inc.
Masbando GmbH
Innoseis
Niko nv
Wellnomics Ltd
iRobot Corporation
Schrader Electronics
Geberit International AG
Fourth Evolution Inc

FMW electronic Futterer u. Maier-Wolf OHG
John Deere
Rookery Technology Ltd
KeySafe-Cloud
BUCHI Labortechnik AG
IQAir AG
Triax Technologies Inc
Vuzix Corporation
TDK Corporation
Blueair AB
Signify Netherlands B.V.
ADH GUARDIAN USA LLC
Beurer GmbH
Playfinity AS
Hans Dinslage GmbH
OnAsset Intelligence, Inc.
INTER ACTION Corporation
OS42 UG (haftungsbeschraenkt)

Audio-Technica Corporation
Six Guys Labs, s.r.o.
R.W. Beckett Corporation
silex technology, inc.
Univations Limited
SENS Innovation ApS
Diamond Kinetics, Inc.
Phrame Inc.
Forciot Oy
Noordung d.o.o.
Beam Labs, LLC

Biovotion AG
Square Panda, Inc.
Amplifico
WEG S.A.
Ensto Oy
PHONEPE PVT LTD

MinebeaMitsumi Inc.
ASPion GmbH
Vossloh-Schwabe Deutschland GmbH
Procept
ONKYO Corporation
Asthrea D.O.O.
Fortiori Design LLC
Hugo Muller GmbH & Co KG
Wangi Lai PLT
Fanstel Corp
Crookwood
ELECTRONICA INTEGRAL DE SONIDO S.A.
GiP Innovation Tools GmbH
LX SOLUTIONS PTY LIMITED
Shenzhen Minew Technologies Co., Ltd.
Prolojik Limited
Kromek Group Plc
Contec Medical Systems Co., Ltd.
Xradio Technology Co.,Ltd.
The Indoor Lab, LLC
LDL TECHNOLOGY
Dish Network LLC
Revenue Collection Systems FRANCE SAS
Bluetrum Technology Co.,Ltd
makita corporation
Apogee Instruments
BM3
SGV Group Holding GmbH & Co. KG
MED-EL
Ultune Technologies
Ryeex Technology Co.,Ltd.
Open Research Institute, Inc.
Scale-Tec, Ltd
Zumtobel Group AG
iLOQ Oy
KRUXWorks Technologies Private Limited
Digital Matter Pty Ltd
Coravin, Inc.
Stasis Labs, Inc.
ITZ Innovations- und Technologiezentrum GmbH
Meggitt SA
Ledlenser GmbH & Co. KG
Renishaw PLC
ZhuHai AdvanPro Technology Company Limited
Meshtronix Limited
Payex Norge AS
UnSeen Technologies Oy
Marshall Group AB
Sesam Solutions BV
PixArt Imaging Inc.
Panduit Corp.
Alo AB
Ricoh Company Ltd
RTC Industries, Inc.
Mode Lighting Limited
Particle Industries, Inc.
Advanced Telemetry Systems, Inc.
RHA TECHNOLOGIES LTD
Pure International Limited
WTO Werkzeug-Einrichtungen GmbH

Bleb Technology srl
Livanova USA, Inc.
Brady Worldwide Inc.
DewertOkin GmbH
Ztove ApS
Venso EcoSolutions AB
Eurotronik Kranj d.o.o.
Hug Technology Ltd
Gema Switzerland GmbH
Buzz Products Ltd.
Kopi
Innova Ideas Limited
BeSpoon

Expai Solutions Private Limited
Innovation First, Inc.
SABIK Offshore GmbH
4iiii Innovations Inc.
The Energy Conservatory, Inc.
I.FARM, INC.
Tile, Inc.
Form Athletica Inc.

NETGRID S.N.C. DI BISSOLI MATTEO, CAMPOREALE SIMONE, TOGNETTI FEDERICO
Mannkind Corporation
Trade FIDES a.s.
Photron Limited
Eltako GmbH
Dermalapps, LLC
Greenwald Industries
inQs Co., Ltd.
Cherry GmbH
Amsted Digital Solutions Inc.
Tacx b.v.
Raytac Corporation
Jiangsu Teranovo Tech Co., Ltd.


Razer Inc.
JRM Group Limited
Eccrine Systems, Inc.
Curie Point AB
Georg Fischer AG
Hach - Danaher
T&A Laboratories LLC
Koki Holdings Co., Ltd.
Gunakar Private Limited
Stemco Products Inc
Wood IT Security, LLC
RandomLab SAS
Adero, Inc.
Dragonchip Limited
Noomi AB

Delta Electronics, Inc.
FlowMotion Technologies AS
OBIQ Location Technology Inc.
Cardo Systems, Ltd
Globalworx GmbH
Nymbus, LLC
LIMNO Co. Ltd.
TEKZITEL PTY LTD
Roambee Corporation
Chipsea Technologies (ShenZhen) Corp.
GD Midea Air-Conditioning Equipment Co., Ltd.
Soundmax Electronics Limited
Produal Oy
HMS Industrial Networks AB
Ingchips Technology Co., Ltd.
InnovaSea Systems Inc.
SenseQ Inc.
Shoof Technologies
BRK Brands, Inc.
SimpliSafe, Inc.
Tussock Innovation 2013 Limited

Sencilion Oy
Wabilogic Ltd.
Sociometric Solutions, Inc.
iCOGNIZE GmbH
ShadeCraft, Inc
Beflex Inc.
Beaconzone Ltd
Leaftronix Analogic Solutions Private Limited
TWS Srl
ABB Oy
HitSeed Oy

CAME S.p.A.
Alarm.com Holdings, Inc
Measurlogic Inc.
King I Electronics.Co.,Ltd
Dream Labs GmbH
Urban Compass, Inc
Simm Tronic Limited

Storz & Bickel GmbH & Co. KG
MYLAPS B.V.
Shenzhen Zhongguang Infotech Technology Development Co., Ltd
Dyeware, LLC
Dongguan SmartAction Technology Co.,Ltd.
DIG Corporation
FIOR & GENTZ

Etekcity Corporation
Meyer Sound Laboratories, Incorporated
CeoTronics AG


Sensirion AG
JCT Healthcare Pty Ltd
FUBA Automotive Electronics GmbH
AW Company
Shanghai Mountain View Silicon Co.,Ltd.
Zliide Technologies ApS
Automatic Labs, Inc.
Industrial Network Controls, LLC
Intellithings Ltd.
Navcast, Inc.
HLI Solutions Inc.
Avaya Inc.
Milestone AV Technologies LLC
Alango Technologies Ltd
Spinlock Ltd
Aluna
OPTEX CO.,LTD.
NIHON DENGYO KOUSAKU
VELUX A/S
Almendo Technologies GmbH
Zmartfun Electronics, Inc.
SafeLine Sweden AB
Houston Radar LLC

J Neades Ltd

ALCARE Co., Ltd.
Chargy Technologies, SL
Shibutani Co., Ltd.
Trapper Data AB
Alfred International Inc.
Touché Technology Ltd
Vigil Technologies Inc.
Vitulo Plus BV
WILKA Schliesstechnik GmbH
BodyPlus Technology Co.,Ltd
happybrush GmbH
Enequi AB
Sartorius AG
Tom Communication Industrial Co.,Ltd.
ESS Embedded System Solutions Inc.
Mahr GmbH
Redpine Signals Inc
TraqFreq LLC
PAFERS TECH
Akciju sabiedriba "SAF TEHNIKA"
Beijing Jingdong Century Trading Co., Ltd.
JBX Designs Inc.
AB Electrolux
Wernher von Braun Center for ASdvanced Research
Essity Hygiene and Health Aktiebolag
Be Interactive Co., Ltd
Carewear Corp.

Element Products, Inc.
Beijing Winner Microelectronics Co.,Ltd
SmartSnugg Pty Ltd
FiveCo Sarl
California Things Inc.
Audiodo AB
ABAX AS
Bull Group Company Limited
Respiri Limited
MindPeace Safety LLC
MBARC LABS Inc
Altonics

IDIBAIX enginneering
COREIOT PTY LTD
REVSMART WEARABLE HK CO LTD
Precor
F5 Sports, Inc
exoTIC Systems
DONGGUAN HELE ELECTRONICS CO., LTD
Dongguan Liesheng Electronic Co.Ltd
Oculeve, Inc.
Clover Network, Inc.
Xiamen Eholder Electronics Co.Ltd
Ford Motor Company
Guangzhou SuperSound Information Technology Co.,Ltd
Tedee Sp. z o.o.
PHC Corporation

Eli Lilly and Company
SwaraLink Technologies
JMR embedded systems GmbH
Bitkey Inc.
GWA Hygiene GmbH
Safera Oy
Open Platform Systems LLC
OnePlus Electronics (Shenzhen) Co., Ltd.
Wildlife Acoustics, Inc.
ABLIC Inc.
Dairy Tech, LLC
Iguanavation, Inc.
DiUS Computing Pty Ltd
UpRight Technologies LTD
Luna XIO, Inc.
LLC Navitek
Glass Security Pte Ltd
Jiangsu Qinheng Co., Ltd.
Chandler Systems Inc.
Fantini Cosmi s.p.a.

Beijing Hao Heng Tian Tech Co., Ltd.
Bluepack S.R.L.
Beijing Unisoc Technologies Co., Ltd.

MAC SRL
DML LLC
Sanofi
SOCOMEC
WIZNOVA, Inc.
Seitec Elektronik GmbH
OR Technologies Pty Ltd
GuangZhou KuGou Computer Technology Co.Ltd
DIAODIAO (Beijing) Technology Co., Ltd.
Illusory Studios LLC
Sarvavid Software Solutions LLP

Amtech Systems, LLC
EAGLE DETECTION SA
MEDIATECH S.R.L.
Hamilton Professional Services of Canada Incorporated
Changsha JEMO IC Design Co.,Ltd
Elatec GmbH
JLG Industries, Inc.
Michael Parkin
Brother Industries, Ltd
Lumens For Less, Inc
ELA Innovation
umanSense AB
Shanghai InGeek Cyber Security Co., Ltd.
HARMAN CO.,LTD.
Smart Sensor Devices AB
Antitronics Inc.
RHOMBUS SYSTEMS, INC.
Katerra Inc.
Remote Solution Co., LTD.
Vimar SpA
Mantis Tech LLC
TerOpta Ltd
PIKOLIN S.L.
WWZN Information Technology Company Limited
Voxx International
ART AND PROGRAM, INC.
NITTO DENKO ASIA TECHNICAL CENTRE PTE. LTD.
Peloton Interactive Inc.
Force Impact Technologies
Dmac Mobile Developments, LLC
Engineered Medical Technologies
Noodle Technology inc
Graesslin GmbH
WuQi technologies, Inc.
Successful Endeavours Pty Ltd
InnoCon Medical ApS
Corvex Connected Safety
Thirdwayv Inc.

C-MAX Asia Limited
4eBusiness GmbH
Cyber Transport Control GmbH
Cue
KOAMTAC INC.
Loopshore Oy
Niruha Systems Private Limited

radius co., ltd.
Sensority, s.r.o.
Sparkage Inc.
Glenview Software Corporation
Finch Technologies Ltd.
Qingping Technology (Beijing) Co., Ltd.
DeviceDrive AS
ESEMBER LIMITED LIABILITY COMPANY
audifon GmbH & Co. KG
O2 Micro, Inc.


BubblyNet, LLC
PCB Piezotronics, Inc.
The Wildflower Foundation
Optikam Tech Inc.
MINIBREW HOLDING B.V
Cybex GmbH
FUJIMIC NIIGATA, INC.
Hanna Instruments, Inc.
KOMPAN A/S
Scosche Industries, Inc.
Cricut, Inc.
AEV spol. s r.o.
The Coca-Cola Company
GASTEC CORPORATION
StarLeaf Ltd
Water-i.d. GmbH
HoloKit, Inc.
PlantChoir Inc.
GuangDong Oppo Mobile Telecommunications Corp., Ltd.
CST ELECTRONICS (PROPRIETARY) LIMITED
Sky UK Limited
Digibale Pty Ltd
Smartloxx GmbH
Pune Scientific LLP
Regent Beleuchtungskorper AG

Roku, Inc.

Xiamen Mage Information Technology Co., Ltd.
RAB Lighting, Inc.
Musen Connect, Inc.
Zume, Inc.
conbee GmbH
Bruel & Kjaer Sound & Vibration
The Kroger Co.
Granite River Solutions, Inc.
LoupeDeck Oy
New H3C Technologies Co.,Ltd
Aurea Solucoes Tecnologicas Ltda.
Hong Kong Bouffalo Lab Limited
GV Concepts Inc.
Thomas Dynamics, LLC
Moeco IOT Inc.
2N TELEKOMUNIKACE a.s.
Hormann KG Antriebstechnik
CRONO CHIP, S.L.
Soundbrenner Limited
ETABLISSEMENTS GEORGES RENAULT
iSwip

Battery-Biz Inc.
EPIC S.R.L.

Genedrive Diagnostics Ltd
Axentia Technologies AB
REGULA Ltd.
Biral AG

Radinn AB
CIMTechniques, Inc.
Johnson Health Tech NA
June Life, Inc.
Bluenetics GmbH
iaconicDesign Inc.
WRLDS Creations AB
Skullcandy, Inc.

West Pharmaceutical Services, Inc.
Barnacle Systems Inc.
Smart Wave Technologies Canada Inc
Shanghai Top-Chip Microelectronics Tech. Co., LTD
NeoSensory, Inc.
Hangzhou Tuya Information Technology Co., Ltd
Shanghai Panchip Microelectronics Co., Ltd
React Accessibility Limited
LIVNEX Co.,Ltd.
Kano Computing Limited
hoots classic GmbH
ecobee Inc.
Nanjing Qinheng Microelectronics Co., Ltd
SOLUTIONS AMBRA INC.
Micro-Design, Inc.
STARLITE Co., Ltd.
Remedee Labs
ThingOS GmbH & Co KG
Linear Circuits
Unlimited Engineering SL
Snap-on Incorporated
Edifier International Limited

Alfred Kaercher SE & Co. KG
Airoha Technology Corp.
Geeksme S.L.
Minut, Inc.
Waybeyond Limited
Komfort IQ, Inc.
Packetcraft, Inc.
Häfele GmbH & Co KG
ShapeLog, Inc.
NOVABASE S.R.L.
Frecce LLC
Joule IQ, INC.
KidzTek LLC
Aktiebolaget Sandvik Coromant
e-moola.com Pty Ltd
Zimi Innovations Pty Ltd
SERENE GROUP, INC
DIGISINE ENERGYTECH CO. LTD.
MEDIRLAB Orvosbiologiai Fejleszto Korlatolt Felelossegu Tarsasag
Byton North America Corporation
Shenzhen TonliScience and Technology Development Co.,Ltd
Cesar Systems Ltd.
quip NYC Inc.

Klipsch Group, Inc.
Access Co., Ltd
Renault SA
JSK CO., LTD.
BIROTA
maxon motor ltd.
Optek
CRONUS ELECTRONICS LTD
NantSound, Inc.
Domintell s.a.
Andon Health Co.,Ltd
Urbanminded Ltd
TYRI Sweden AB
ECD Electronic Components GmbH Dresden
SISTEMAS KERN, SOCIEDAD ANÓMINA
Trulli Audio
Altaneos
Nanoleaf Canada Limited
Ingy B.V.
Azbil Co.
TATTCOM LLC
Paradox Engineering SA
LECO Corporation
Becker Antriebe GmbH
Mstream Technologies., Inc.
Flextronics International USA Inc.
Ossur hf.
SKC Inc
SPICA SYSTEMS LLC
Wangs Alliance Corporation
tatwah SA
Hunter Douglas Inc
Shenzhen Conex
DIM3
Bobrick Washroom Equipment, Inc.
Potrykus Holdings and Development LLC
iNFORM Technology GmbH
eSenseLab LTD
Brilliant Home Technology, Inc.
INOVA Geophysical, Inc.
adafruit industries

8Power Limited
CME PTE. LTD.
Hyundai Motor Company
Kickmaker
Shanghai Suisheng Information Technology Co., Ltd.
HEXAGON METROLOGY DIVISION ROMER
Mitutoyo Corporation
shenzhen fitcare electronics Co.,Ltd
INGICS TECHNOLOGY CO., LTD.
INCUS PERFORMANCE LTD.
ABB S.p.A.
Blippit AB

Foxble, LLC
Intermotive,Inc.
Conneqtech B.V.
RIKEN KEIKI CO., LTD.,
Canopy Growth Corporation
Bitwards Oy
vivo Mobile Communication Co., Ltd.
Etymotic Research, Inc.
A puissance 3
BPW Bergische Achsen Kommanditgesellschaft
Piaggio Fast Forward
BeerTech LTD
Tokenize, Inc.
Zorachka LTD
D-Link Corp.
Down Range Systems LLC
General Luminaire (Shanghai) Co., Ltd.
Tangshan HongJia electronic technology co., LTD.
FRAGRANCE DELIVERY TECHNOLOGIES LTD
Pepperl + Fuchs GmbH
Dometic Corporation
USound GmbH
DNANUDGE LIMITED
JUJU JOINTS CANADA CORP.
Dopple Technologies B.V.
ARCOM
Biotechware SRL
ORSO Inc.
SafePort
Carol Cole Company
Embedded Fitness B.V.
Yealink (Xiamen) Network Technology Co.,LTD
Subeca, Inc.
Cognosos, Inc.
Pektron Group Limited
Tap Sound System
Helios Sports, Inc.
Canopy Growth Corporation
Parsyl Inc
SOUNDBOKS
BlueUp
DAKATECH
Nisshinbo Micro Devices Inc.
ACOS CO.,LTD.
Guilin Zhishen Information Technology Co.,Ltd.
Krog Systems LLC

Alflex Products B.V.
SmartSensor Labs Ltd
SmartDrive
Yo-tronics Technology Co., Ltd.
Rafaelmicro
Emergency Lighting Products Limited
LAONZ Co.,Ltd
Western Digital Techologies, Inc.
WIOsense GmbH & Co. KG
EVVA Sicherheitstechnologie GmbH
Odic Incorporated
Pacific Track, LLC
Revvo Technologies, Inc.
Biometrika d.o.o.
Vorwerk Elektrowerke GmbH & Co. KG
Trackunit A/S
Wyze Labs, Inc
Dension Elektronikai Kft.
11 Health & Technologies Limited
Innophase Incorporated
Treegreen Limited
Berner International LLC
SmartResQ ApS
Valtech
The Chamberlain Group, Inc.
MIZUNO Corporation
ZRF, LLC
BYSTAMP
Crosscan GmbH
Konftel AB
1bar.net Limited
Phillips Connect Technologies LLC
imagiLabs AB
Optalert
PSYONIC, Inc.
Wintersteiger AG
Controlid Industria, Comercio de Hardware e Servicos de Tecnologia Ltda

Movella Technologies B.V.
Hydro-Gear Limited Partnership
EnPointe Fencing Pty Ltd
XANTHIO
sclak s.r.l.
Tricorder Arraay Technologies LLC
GB Solution co.,Ltd
Soliton Systems K.K.

Tait International Limited
NICHIEI INTEC CO., LTD.
SmartWireless GmbH & Co. KG
Ingenieurbuero Birnfeld UG (haftungsbeschraenkt)
Maytronics Ltd
EPIFIT
Gimer medical
Nokian Renkaat Oyj
Current Lighting Solutions LLC

SFS unimarket AG
Private limited company "Teltonika"
Saucon Technologies
Embedded Devices Co. Company
J-J.A.D.E. Enterprise LLC
i-SENS, inc.
Witschi Electronic Ltd
Aclara Technologies LLC
EXEO TECH CORPORATION
Epic Systems Co., Ltd.
Hoffmann SE
Realme Chongqing Mobile Telecommunications Corp., Ltd.

Intelligenceworks Inc.
TGR 1.618 Limited
Shanghai Kfcube Inc
Fraunhofer IIS
SZ DJI TECHNOLOGY CO.,LTD
Coburn Technology, LLC
Topre Corporation
Kayamatics Limited
Moticon ReGo AG
Polidea Sp. z o.o.
Trivedi Advanced Technologies LLC
CORE|vision BV
PF SCHWEISSTECHNOLOGIE GMBH
IONIQ Skincare GmbH & Co. KG
Sengled Co., Ltd.

Boehringer Ingelheim Vetmedica GmbH
ABB Inc
Check Technology Solutions LLC
U-Shin Ltd.
HYPER ICE, INC.
Tokai-rika co.,ltd.
Prevayl Limited
bf1systems limited
ubisys technologies GmbH
SIRC Co., Ltd.
Accent Advanced Systems SLU
Rayden.Earth LTD
Lindinvent AB
CHIPOLO d.o.o.

J. Wagner GmbH

Monadnock Systems Ltd.
Liteboxer Technologies Inc.
Noventa AG
Nubia Technology Co.,Ltd.
JT INNOVATIONS LIMITED
TGM TECHNOLOGY CO., LTD.
ifly
ZIMI CORPORATION
betternotstealmybike UG (with limited liability)
ESTOM Infotech Kft.
Sensovium Inc.
Virscient Limited
Novel Bits, LLC
ADATA Technology Co., LTD.
KEYes

Inovonics Corp
WARES
Pointr Labs Limited
Miridia Technology Incorporated
Tertium Technology
SHENZHEN AUKEY E BUSINESS CO., LTD
code-Q
TE Connectivity Corporation
IRIS OHYAMA CO.,LTD.
Philia Technology
KOZO KEIKAKU ENGINEERING Inc.
Shenzhen Simo Technology co. LTD
Republic Wireless, Inc.
Rashidov ltd
Crowd Connected Ltd
Eneso Tecnologia de Adaptacion S.L.
Barrot Technology Co.,Ltd.
Naonext
Taiwan Intelligent Home Corp.
COWBELL ENGINEERING CO.,LTD.
Beijing Big Moment Technology Co., Ltd.
Denso Corporation
IMI Hydronic Engineering International SA
Askey Computer Corp.
Cumulus Digital Systems, Inc
Joovv, Inc.
The L.S. Starrett Company
Microoled
PSP - Pauli Services & Products GmbH
Kodimo Technologies Company Limited
Tymtix Technologies Private Limited
Dermal Photonics Corporation
MTD Products Inc & Affiliates
instagrid GmbH
Spacelabs Medical Inc.

Darkglass Electronics Oy
Hill-Rom
BioIntelliSense, Inc.
Ketronixs Sdn Bhd
Plastimold Products, Inc
Beijing Zizai Technology Co., LTD.
Lucimed
TSC Auto-ID Technology Co., Ltd.
DATAMARS, Inc.
SUNCORPORATION
Yandex Services AG
Scope Logistical Solutions
User Hello, LLC
Pinpoint Innovations Limited
70mai Co.,Ltd.
Zhuhai Hoksi Technology CO.,LTD
EMBR labs, INC
Radiawave Technologies Co.,Ltd.

OPTIMUSIOT TECH LLP
VC Inc.
ASR Microelectronics (Shanghai) Co., Ltd.
Douglas Lighting Controls Inc.
Nerbio Medical Software Platforms Inc
Braveheart Wireless, Inc.
INEO-SENSE
Honda Motor Co., Ltd.
Ambient Sensors LLC
ASR Microelectronics(ShenZhen)Co., Ltd.

NO SMD LIMITED
Albertronic BV
Luminostics, Inc.
Oblamatik AG
Innokind, Inc.
Melbot Studios, Sociedad Limitada
Myzee Technology

KAHA PTE. LTD.
Shanghai MXCHIP Information Technology Co., Ltd.
JSB TECH PTE LTD

Yukai Engineering Inc.
Gooligum Technologies Pty Ltd
ROOQ GmbH
AiRISTA
Qingdao Haier Technology Co., Ltd.
Sappl Verwaltungs- und Betriebs GmbH
TekHome
PCI Private Limited
Leggett & Platt, Incorporated
PS GmbH
C.O.B.O. SpA
James Walker RotaBolt Limited
BREATHINGS Co., Ltd.

SRAM
KiteSpring Inc.
Reconnect, Inc.
Elekon AG
RealThingks GmbH
Henway Technologies, LTD.
ASTEM Co.,Ltd.
LinkedSemi Microelectronics (Xiamen) Co., Ltd
ENSESO LLC
Xenoma Inc.
Adolf Wuerth GmbH & Co KG
Catalyft Labs, Inc.
JEPICO Corporation
Hero Workout GmbH
Rivian Automotive, LLC
TRANSSION HOLDINGS LIMITED

Agitron d.o.o.
Globe (Jiangsu) Co., Ltd
AMC International Alfa Metalcraft Corporation AG
First Light Technologies Ltd.
Wearable Link Limited
Metronom Health Europe
Zwift, Inc.
Kindeva Drug Delivery L.P.
GimmiSys GmbH
tkLABS INC.
PassiveBolt, Inc.
Limited Liability Company "Mikrotikls"
Capetech
PPRS
Apptricity Corporation
LogiLube, LLC
Julbo
Breville Group
Kerlink
Ohsung Electronics
ZTE Corporation
HerdDogg, Inc

Lismore Instruments Limited
LogiLube, LLC
Electronic Theatre Controls
BioEchoNet inc.
NUANCE HEARING LTD
Sena Technologies Inc.
Linkura AB
GL Solutions K.K.
Moonbird BV
Countrymate Technology Limited
Asahi Kasei Corporation
PointGuard, LLC
Neo Materials and Consulting Inc.
Actev Motors, Inc.
Woan Technology (Shenzhen) Co., Ltd.
dricos, Inc.
Guide ID B.V.

Gunwerks, LLC
Band Industries, inc.

IBA Dosimetry GmbH
GA

Popit Oy
ABEYE
BlueIOT(Beijing) Technology Co.,Ltd
Fauna Audio GmbH
TOYOTA motor corporation
ZifferEins GmbH & Co. KG
BIOTRONIK SE & Co. KG
CORE CORPORATION
CTEK Sweden AB
Thorley Industries, LLC
CLB B.V.
SonicSensory Inc
ISEMAR S.R.L.
DEKRA TESTING AND CERTIFICATION, S.A.U.
Bernard Krone Holding SE & Co.KG
ELPRO-BUCHS AG
Feedback Sports LLC
TeraTron GmbH

Cello Hill, LLC
TSE BRAKES, INC.
BHM-Tech Produktionsgesellschaft m.b.H
WIKA Alexander Wiegand SE & Co.KG
Biovigil
Mequonic Engineering, S.L.
bGrid B.V.

ADVEEZ
Aktiebolaget Regin
Anton Paar GmbH
Telenor ASA
Big Kaiser Precision Tooling Ltd
Absolute Audio Labs B.V.
VT42 Pty Ltd
Bronkhorst High-Tech B.V.
C. & E. Fein GmbH
NextMind
Pixie Dust Technologies, Inc.
eTactica ehf
New Audio LLC
Sendum Wireless Corporation
deister electronic GmbH
YKK AP Inc.
Step One Limited
Koya Medical, Inc.
Proof Diagnostics, Inc.
VOS Systems, LLC
ENGAGENOW DATA SCIENCES PRIVATE LIMITED
ARDUINO SA
KUMHO ELECTRICS, INC
Security Enhancement Systems, LLC
BEIJING ELECTRIC VEHICLE CO.,LTD
Paybuddy ApS
KHN Solutions LLC
Nippon Ceramic Co.,Ltd.
PHOTODYNAMIC INCORPORATED
DashLogic, Inc.
Ambiq
Narhwall Inc.
Pozyx NV
ifLink Open Community
Deublin Company, LLC
BLINQY
DYPHI
BlueX Microelectronics Corp Ltd.
PentaLock Aps.
AUTEC Gesellschaft fuer Automationstechnik mbH
Pegasus Technologies, Inc.
Bout Labs, LLC
PlayerData Limited
SAVOY ELECTRONIC LIGHTING
Elimo Engineering Ltd
SkyStream Corporation
Aerosens LLC
Centre Suisse d'Electronique et de Microtechnique SA
Vessel Ltd.
Span.IO, Inc.
AnotherBrain inc.
Rosewill
Universal Audio, Inc.
JAPAN TOBACCO INC.
UVISIO
HungYi Microelectronics Co.,Ltd.
Honor Device Co., Ltd.
Combustion, LLC
XUNTONG
CrowdGlow Ltd
Mobitrace
Hx Engineering, LLC
Senso4s d.o.o.

Julius Blum GmbH
BlueStreak IoT, LLC
Chess Wise B.V.
ABLEPAY TECHNOLOGIES AS
Temperature Sensitive Solutions Systems Sweden AB

ORBIS Inc.
GEAR RADIO ELECTRONICS CORP.
EAR TEKNIK ISITME VE ODIOMETRI CIHAZLARI SANAYI VE TICARET ANONIM SIRKETI
Coyotta
Synergy Tecnologia em Sistemas Ltda
VivoSensMedical GmbH
Nagravision SA
Bionic Avionics Inc.

Innoware Development AB
JLD Technology Solutions, LLC
Magnus Technology Sdn Bhd

Tag-N-Trac Inc

Friday Home Aps
CPS AS
Mobilogix
Masonite Corporation
Kabushikigaisha HANERON
Melange Systems Pvt. Ltd.
LumenRadio AB
Athlos Oy
KEAN ELECTRONICS PTY LTD
Yukon advanced optics worldwide, UAB
Sibel Inc.
OJMAR SA
Steinel Solutions AG
WatchGas B.V.
OM Digital Solutions Corporation
Audeara Pty Ltd
Beijing Zero Zero Infinity Technology Co.,Ltd.
Spectrum Technologies, Inc.
OKI Electric Industry Co., Ltd
Mobile Action Technology Inc.
SENSATEC Co., Ltd.
R.O. S.R.L.
Hangzhou Yaguan Technology Co. LTD
Listen Technologies Corporation
TOITU CO., LTD.
Confidex

Lichtvision Engineering GmbH
AIRSTAR
Ampler Bikes OU
Cleveron AS
Ayxon-Dynamics GmbH
donutrobotics Co., Ltd.
Flosonics Medical
Southwire Company, LLC
Shanghai wuqi microelectronics Co.,Ltd
Reflow Pty Ltd
Oras Oy

Volan Technology Inc.

Shanghai Yidian Intelligent Technology Co., Ltd.
Blue Peacock GmbH
Roland Corporation
LIXIL Corporation
SUBARU Corporation
Sensolus
Dyson Technology Limited
Tec4med LifeScience GmbH
CROXEL, INC.
Syng Inc

Plume Design Inc
Cambridge Animal Technologies Ltd
Maxell, Ltd.
Link Labs, Inc.
Embrava Pty Ltd
INPEAK sp. z o.o.
API-K
CombiQ AB
DeVilbiss Healthcare LLC
Jiangxi Innotech Technology Co., Ltd
Apollogic Sp. z o.o.
DAIICHIKOSHO CO., LTD.
BIXOLON CO.,LTD
Atmosic Technologies, Inc.
Eran Financial Services LLC
Louis Vuitton

NanoFlex Power Corporation
Worthcloud Technology Co.,Ltd
Yamaha Corporation
PaceBait IVS
Shenzhen H&T Intelligent Control Co., Ltd
Shenzhen Feasycom Technology Co., Ltd.

Instamic, Inc.
Air-Weigh
Nevro Corp.
Pinnacle Technology, Inc.
WMF AG
Luxer Corporation
safectory GmbH
NGK SPARK PLUG CO., LTD.
2587702 Ontario Inc.
Bouffalo Lab (Nanjing)., Ltd.
BLUETICKETING SRL

Galileo Technology Limited
Siteco GmbH
DELABIE

Shenzhen Yopeak Optoelectronics Technology Co., Ltd.

OPEX Corporation
Motionalysis, Inc.
Busch Systems International Inc.
Novidan, Inc.
3SI Security Systems, Inc
Beijing HC-Infinite Technology Limited
The Wand Company Ltd
JRC Mobility Inc.

Map Large, Inc.
MistyWest Energy and Transport Ltd.
SiFli Technologies (shanghai) Inc.
Lockn Technologies Private Limited
Toytec Corporation
VANMOOF Global Holding B.V.
Nextscape Inc.
CSIRO
Follow Sense Europe B.V.
KKM COMPANY LIMITED
SQL Technologies Corp.
Inugo Systems Limited
ambie
Meizhou Guo Wei Electronics Co., Ltd
Indigo Diabetes
TourBuilt, LLC
Sontheim Industrie Elektronik GmbH
LEGIC Identsystems AG
Innovative Design Labs Inc.
MG Energy Systems B.V.

stryker
DATANG SEMICONDUCTOR TECHNOLOGY CO.,LTD
Smart Parks B.V.
MOKO TECHNOLOGY Ltd

Geopal system A/S
Lytx, INC.

Beijing SuperHexa Century Technology CO. Ltd
Focus Ingenieria SRL
HAPPIEST BABY, INC.
Scribble Design Inc.
Olympic Ophthalmics, Inc.
Pokkels

Pac Sane Limited
Warner Bros.
Ooma
Senquip Pty Ltd
Jumo GmbH & Co. KG
Innohome Oy
MICROSON S.A.
Delta Cycle Corporation
Synaptics Incorporated
AXTRO PTE. LTD.
Shenzhen Sunricher Technology Limited
Webasto SE
Emlid Limited
UniqAir Oy
WAFERLOCK
Freedman Electronics Pty Ltd
KEBA Handover Automation GmbH
Intuity Medical
Cleer Limited
Universal Biosensors Pty Ltd
Corsair
Rivata, Inc.
Greennote Inc,
Snowball Technology Co., Ltd.
ALIZENT International
Shanghai Smart System Technology Co., Ltd
PSA Peugeot Citroen
VusionGroup
HAINBUCH GMBH SPANNENDE TECHNIK
SANlight GmbH
DelpSys, s.r.o.
JCM TECHNOLOGIES S.A.
Perfect Company
TOTO LTD.
Shenzhen Grandsun Electronic Co.,Ltd.
Monarch International Inc.
Carestream Dental LLC
GiPStech S.r.l.
OOBIK Inc.
Pamex Inc.


Foil, Inc.
Shanghai high-flying electronics technology Co.,Ltd
TEMKIN ASSOCIATES, LLC
Eello LLC
Xi'an Fengyu Information Technology Co., Ltd.
Canon Finetech Nisca Inc.

ista International GmbH
Loy Tec electronics GmbH
LINCOGN TECHNOLOGY CO. LIMITED
Care Bloom, LLC
DIC Corporation
FAZEPRO LLC
Shenzhen Uascent Technology Co., Ltd
Realityworks, inc.
Urbanista AB
Zencontrol Pty Ltd
Spintly, Inc.
Computime International Ltd
Anhui Listenai Co
OSM HK Limited
Adevo Consulting AB
PS Engineering, Inc.
AIAIAI ApS
Visiontronic s.r.o.
InVue Security Products Inc
TouchTronics, Inc.
INNER RANGE PTY. LTD.
Ellenby Technologies, Inc.
Elstat Electronics Ltd.
Xenter, Inc.
LogTag North America Inc.
Sens.ai Incorporated
STL
Open Bionics Ltd.
R-DAS, s.r.o.
KCCS Mobile Engineering Co., Ltd.
Inventas AS
Robkoo Information & Technologies Co., Ltd.
PAUL HARTMANN AG
Omni-ID USA, INC.
Shenzhen Jingxun Technology Co., Ltd.
RealMega Microelectronics technology (Shanghai) Co. Ltd.
Kenzen, Inc.
CODIUM
Flexoptix GmbH
Barnes Group Inc.
Chengdu Aich Technology Co.,Ltd
Keepin Co., Ltd.
Swedlock AB
Shenzhen CoolKit Technology Co., Ltd
ise Individuelle Software und Elektronik GmbH
Nuvoton
Visuallex Sport International Limited
KOBATA GAUGE MFG. CO., LTD.
CACI Technologies
Nordic Strong ApS

Lautsprecher Teufel GmbH
SSV Software Systems GmbH
Zhuhai Pantum Electronisc Co., Ltd
Streamit B.V.
nymea GmbH
AL-KO Geraete GmbH
Franz Kaldewei GmbH&Co KG

Codefabrik GmbH
Reelables, Inc.
Duravit AG
Boss Audio
Vocera Communications, Inc.
Douglas Dynamics L.L.C.



GlobalMed
DALI Alliance
unu GmbH
Hexology
Sunplus Technology Co., Ltd.
LEVEL, s.r.o.
FLIR Systems AB
Borda Technology
Square, Inc.
FUTEK ADVANCED SENSOR TECHNOLOGY, INC
Saxonar GmbH
Velentium, LLC
GLP German Light Products GmbH
Leupold & Stevens, Inc.
CRADERS,CO.,LTD

701x Inc.
Radioworks Microelectronics PTY LTD
Unitech Electronic Inc.
AMETEK, Inc.
Irdeto
First Design System Inc.
Unisto AG
Chengdu Ambit Technology Co., Ltd.
SMT ELEKTRONIK GmbH
Cerebrum Sensor Technologies Inc.
Weber Sensors, LLC
Earda Technologies Co.,Ltd
FUSEAWARE LIMITED
Flaircomm Microelectronics Inc.
RESIDEO TECHNOLOGIES, INC.
IORA Technology Development Ltd. Sti.
Precision Triathlon Systems Limited

Marquardt GmbH
FAZUA GmbH
Workaround Gmbh
Shenzhen Qianfenyi Intelligent Technology Co., LTD

Belun Technology Company Limited
Sanistaal A/S
BluPeak
SANYO DENKO Co.,Ltd.
Minebea Access Solutions Inc.
B.E.A. S.A.
Alfa Laval Corporate AB
ThermoWorks, Inc.
ToughBuilt Industries LLC
IOTOOLS
Olumee
NAOS JAPAN K.K.
Guard RFID Solutions Inc.
SIG SAUER, INC.
DECATHLON SE
WBS PROJECT H PTY LTD
Roca Sanitario, S.A.

Nanoleq AG
Accelerated Systems
PB INC.
Beijing ESWIN Computing Technology Co., Ltd.
TKH Security B.V.

Hygiene IQ, LLC.
iRhythm Technologies, Inc.
BeiJing ZiJie TiaoDong KeJi Co.,Ltd.
NIBROTECH LTD
Baracoda Daily Healthtech.
Lumi United Technology Co., Ltd

Tech-Venom Entertainment Private Limited

MAINBOT
ILLUMAGEAR, Inc.
REDARC ELECTRONICS PTY LTD
MOCA System Inc.
Duke Manufacturing Co
ART SPA
Silver Wolf Vehicles Inc.
Hala Systems, Inc.
ARMATURA LLC
CONZUMEX INDUSTRIES PRIVATE LIMITED
BH SENS
SINTEF
Omnivoltaic Energy Solutions Limited Company
WISYCOM S.R.L.
Red 100 Lighting Co., ltd.
Impact Biosystems, Inc.
AIC semiconductor (Shanghai) Co., Ltd.
Dodge Industrial, Inc.
REALTIMEID AS
ISEO Serrature S.p.a.
MindRhythm, Inc.
Havells India Limited
Sentrax GmbH
TSI
INCITAT ENVIRONNEMENT
nFore Technology Co., Ltd.
Electronic Sensors, Inc.

Gentex Corporation
NIO USA, Inc.
SkyHawke Technologies
Nomono AS
EMS Integrators, LLC
BiosBob.Biz
Adam Hall GmbH
ICP Systems B.V.
Breezi.io, Inc.
Mesh Systems LLC
FUN FACTORY GmbH
ZIIP Inc
SHENZHEN KAADAS INTELLIGENT TECHNOLOGY CO.,Ltd
Emotion Fitness GmbH & Co. KG
H G M Automotive Electronics, Inc.
BORA - Vertriebs GmbH & Co KG
CONVERTRONIX TECHNOLOGIES AND SERVICES LLP
TOKAI-DENSHI INC


Shenzhen ImagineVision Technology Limited

Fujian Newland Auto-ID Tech. Co., Ltd.
CELLCONTROL, INC.
Rivieh, Inc.
RATOC Systems, Inc.
Sentek Pty Ltd
NOVEA ENERGIES
Innolux Corporation
NingBo klite Electric Manufacture Co.,LTD
The Apache Software Foundation
MITSUBISHI ELECTRIC AUTOMATION (THAILAND) COMPANY LIMITED

Quha oy
Addaday
Dymo
Samsara Networks, Inc
Sensitech, Inc.
SOLUM CO., LTD
React Mobile

JDRF Electromag Engineering Inc
lilbit ODM AS
Geeknet, Inc.
HARADA INDUSTRY CO., LTD.
BQN
Triple W Japan Inc.
MAX-co., ltd
Aixlink(Chengdu) Co., Ltd.
FIELD DESIGN INC.
Sankyo Air Tech Co.,Ltd.
Shenzhen KTC Technology Co.,Ltd.
Hardcoder Oy
Scangrip A/S
FoundersLane GmbH
Offcode Oy
ICU tech GmbH
AXELIFE
SCM Group
Mammut Sports Group AG
Taiga Motors Inc.
Presidio Medical, Inc.
VIMANA TECH PTY LTD
Trek Bicycle
Ampetronic Ltd
Muguang (Guangdong) Intelligent Lighting Technology Co., Ltd
Rotronic AG
Seiko Instruments Inc.
American Technology Components, Incorporated
MOTREX
Pertech Industries Inc
Gentle Energy Corp.
Senscomm Semiconductor Co., Ltd.

Alfen ICU B.V.

Hangzhou BroadLink Technology Co., Ltd.
Dreem SAS

Telecom Design
SILVER TREE LABS, INC.
Gymstory B.V.
The Goodyear Tire & Rubber Company
Beijing Wisepool Infinite Intelligence Technology Co.,Ltd

Komatsu Ltd.
Sensoria Holdings LTD
Audio Partnership Plc
Group Lotus Limited
Data Sciences International
Bunn-O-Matic Corporation
TireCheck GmbH
Sonova Consumer Hearing GmbH
Vervent Audio Group
SONICOS ENTERPRISES, LLC
Nissan Motor Co., Ltd.
hearX Group (Pty) Ltd
GLOWFORGE INC.
Allterco Robotics ltd
Infinitegra, Inc.
Grandex International Corporation
Machfu Inc.
Roambotics, Inc.
Soma Labs LLC
NITTO KOGYO CORPORATION
Ecolab Inc.
Beijing ranxin intelligence technology Co.,LTD
Fjorden Electra AS
Flender GmbH
New Cosmos USA, Inc.
Xirgo Technologies, LLC
Build With Robots Inc.
IONA Tech LLC
INNOVAG PTY. LTD.
SaluStim Group Oy
Huso, INC
SWISSINNO SOLUTIONS AG
T2REALITY SOLUTIONS PRIVATE LIMITED

SAAB Aktiebolag
HIMSA II K/S
READY FOR SKY LLP
Miele & Cie. KG
EntWick Co.
MCOT INC.
TECHTICS ENGINEERING B.V.
Aperia Technologies, Inc.
TCL COMMUNICATION EQUIPMENT CO.,LTD.
Signtle Inc.
OTF Distribution, LLC
Neuvatek Inc.
Perimeter Technologies, Inc.
Divesoft s.r.o.
Sylvac sa
Amiko srl
Neurosity, Inc.
LL Tec Group LLC
Durag GmbH
Hubei Yuan Times Technology Co., Ltd.
IDEC
Procon Analytics, LLC
ndd Medizintechnik AG
Super B Lithium Power B.V.
Shenzhen Injoinic Technology Co., Ltd.

PURA SCENTS, INC.

Aardex Ltd.
CHAR-BROIL, LLC
TWINKLY SRL
Coroflo Limited
Yale
WINKEY ENTERPRISE (HONG KONG) LIMITED
Koizumi Lighting Technology corp.

OTC engineering
Comtel Systems Ltd.
Deepfield Connect GmbH
ZWILLING J.A. Henckels Aktiengesellschaft
Puratap Pty Ltd
Fresnel Technologies, Inc.
Sensormate AG
Shindengen Electric Manufacturing Co., Ltd.
Twenty Five Seven, prodaja in storitve, d.o.o.
Luna Health, Inc.

CORAL-TAIYI Co. Ltd.
LINKSYS USA, INC.
Safetytest GmbH
KIDO SPORTS CO., LTD.
Site IQ LLC
Angel Medical Systems, Inc.
PONE BIOMETRICS AS

T5 tek, Inc.
greenTEG AG
Wacker Neuson SE
Innovacionnye Resheniya

CleanBands Systems Ltd.
Dodam Enersys Co., Ltd
T+A elektroakustik GmbH & Co.KG
Esmé Solutions
Media-Cartec GmbH
Ratio Electric BV
MQA Limited
NEOWRK SISTEMAS INTELIGENTES S.A.
Loomanet, Inc.
Puff Corp
Happy Health, Inc.
Montage Connect, Inc.
LED Smart Inc.
CONSTRUKTS, INC.
limited liability company "Red"
Senic Inc.
Automated Pet Care Products, LLC
aconno GmbH
Mendeltron, Inc.
Mereltron bv
ALEX DENKO CO.,LTD.
AETERLINK
Cosmed s.r.l.
Gordon Murray Design Limited
IoSA
Scandinavian Health Limited
Fasetto, Inc.
Geva Sol B.V.
TYKEE PTY. LTD.
SomnoMed Limited
CORROHM
Arlo Technologies, Inc.
Catapult Group International Ltd
Rockchip Electronics Co., Ltd.
GEMU
OFF Line Japan Co., Ltd.
EC sense co., Ltd
LVI Co.
COMELIT GROUP S.P.A.
Foshan Viomi Electrical Technology Co., Ltd
Glamo Inc.
KEYTEC,Inc.
SMARTD TECHNOLOGIES INC.
JURA Elektroapparate AG
Performance Electronics, Ltd.
Pal Electronics
Embecta Corp.
DENSO AIRCOOL CORPORATION
Caresix Inc.
GigaDevice Semiconductor Inc.
Zeku Technology (Shanghai) Corp., Ltd.
OTF Product Sourcing, LLC
Easee AS
BEEHERO, INC.
McIntosh Group Inc
KINDOO LLP
Xian Yisuobao Electronic Technology Co., Ltd.
Exeger Operations AB
BYD Company Limited
Thermokon-Sensortechnik GmbH

SignalQuest, LLC
Noritz Corporation.
TIGER CORPORATION

ORB Innovations Ltd
Classified Cycling
Wrmth Corp.
BELLDESIGN Inc.
Stinger Equipment, Inc.
HORIBA, Ltd.
Control Solutions LLC
Heath Consultants Inc.
Berlinger & Co. AG
ONCELABS LLC
Brose Verwaltung SE, Bamberg

Epsilon Electronics,lnc
VALEO MANAGEMENT SERVICES
twopounds gmbh
atSpiro ApS
ADTRAN, Inc.
Orpyx Medical Technologies Inc.
Seekwave Technology Co.,ltd.
Tactile Engineering, Inc.
SharkNinja Operating LLC
Imostar Technologies Inc.
INNOVA S.R.L.
ESCEA LIMITED
Taco, Inc.
HiViz Lighting, Inc.
Zintouch B.V.
Rheem Sales Company, Inc.
UNEEG medical A/S
Hykso Inc.
CYBERDYNE Inc.
Lockswitch Sdn Bhd
Alban Giacomo S.P.A.
MGM WIRELESSS HOLDINGS PTY LTD
StepUp Solutions ApS
BlueID GmbH
Wuxi Linkpower Microelectronics Co.,Ltd
KEBA Energy Automation GmbH
NNOXX, Inc
Phiaton Corporation
phg Peter Hengstler GmbH + Co. KG
dormakaba Holding AG
WAKO CO,.LTD

TRACKTING S.R.L.
Emerja Corporation

CONSORCIO TRUST CONTROL - NETTEL
GILSON SAS
SNIFF LOGIC LTD
Fidure Corp.
Sensa LLC
Parakey AB
SCARAB SOLUTIONS LTD
BitGreen Technolabz (OPC) Private Limited
StreetCar ORV, LLC
Truma Gerätetechnik GmbH & Co. KG
yupiteru
Embedded Engineering Solutions LLC

TEAC Corporation
CHARGTRON IOT PRIVATE LIMITED
Zhuhai Smartlink Technology Co., Ltd
Triductor Technology (Suzhou), Inc.
PT SADAMAYA GRAHA TEKNOLOGI
Mopeka Products LLC
3ALogics, Inc.

Rochester Sensors, LLC
CARDIOID - TECHNOLOGIES, LDA
Carrier Corporation
NACON
Watchdog Systems LLC
MAXON INDUSTRIES, INC.
Amlogic, Inc.
Qingdao Eastsoft Communication Technology Co.,Ltd
Weltek Technologies Company Limited
Nextivity Inc.
AGZZX OPTOELECTRONICS TECHNOLOGY CO., LTD
A.GLOBAL co.,Ltd.
Heavys Inc
T-Mobile USA
tonies GmbH
Technocon Engineering Ltd.
Radar Automobile Sales(Shandong)Co.,Ltd.
WESCO AG
Yashu Systems
Kesseböhmer Ergonomietechnik GmbH
Movesense Oy
Baxter Healthcare Corporation
Gemstone Lights Canada Ltd.
H+B Hightech GmbH
Deako

Vire Health Oy
ALF Inc.
NTT sonority, Inc.
Sunstone-RTLS Ipari Szolgaltato Korlatolt Felelossegu Tarsasag
Ribbiot, INC.

Dragonfly Energy Corp.
BIGBEN
YAMAHA MOTOR CO.,LTD.
XSENSE LTD
MAQUET GmbH
MITSUBISHI ELECTRIC LIGHTING CO, LTD
Princess Cruise Lines, Ltd.
Megger Ltd
Verve InfoTec Pty Ltd
Sonas, Inc.
Mievo Technologies Private Limited
Shenzhen Poseidon Network Technology Co., Ltd
HERUTU ELECTRONICS CORPORATION
Shenzhen Shokz Co.,Ltd.
Shenzhen Openhearing Tech CO., LTD .
Evident Corporation
NEURINNOV
SwipeSense, Inc.
RF Creations
SHINKAWA Sensor Technology, Inc.
janova GmbH
Eberspaecher Climate Control Systems GmbH
Racketry, d. o. o.
THE EELECTRIC MACARON LLC
Cucumber Lighting Controls Limited

seca GmbH & Co. KG
Ameso Tech (OPC) Private Limited
Emlid Tech Kft.

Pricer AB

Forward Thinking Systems LLC.
Garnet Instruments Ltd.
CLEIO Inc.
Anker Innovations Limited
HMD Global Oy
ABUS August Bremicker Soehne Kommanditgesellschaft
Open Road Solutions, Inc.
Serial Technology Corporation
SB C&S Corp.
TrikThom
Innocent Technology Co., Ltd.
Cyclops Marine Ltd
NOTHING TECHNOLOGY LIMITED
Kord Defence Pty Ltd
YanFeng Visteon(Chongqing) Automotive Electronic Co.,Ltd
SENOSPACE LLC
Shenzhen CESI Information Technology Co., Ltd.
MooreSilicon Semiconductor Technology (Shanghai) Co., LTD.
Imagine Marketing Limited
EQOM SSC B.V.
TechSwipe
Reoqoo IoT Technology Co., Ltd.
Numa Products, LLC
HHO (Hangzhou) Digital Technology Co., Ltd.
Maztech Industries, LLC
SIA Mesh Group
Minami acoustics Limited
Wolf Steel ltd
Circus World Displays Limited
Ypsomed AG
Alif Semiconductor, Inc.

SHENZHEN CHENYUN ELECTRONICS CO., LTD
VODALOGIC PTY LTD
Regal Beloit America, Inc.
CORVENT MEDICAL, INC.
Taiwan Fuhsing
Off-Highway Powertrain Services Germany GmbH
Amina Distribution AS
mwConnect
TAG HEUER SA
Dongguan Yougo Electronics Co.,Ltd.
PEAG, LLC dba JLab Audio
HAYWARD INDUSTRIES, INC.
Shenzhen Tingting Technology Co. LTD
Pacific Coast Fishery Services (2003) Inc.
CV. NURI TEKNIK
MadgeTech, Inc
POGS B.V.
THOTAKA TEKHNOLOGIES INDIA PRIVATE LIMITED
Midmark

Radio Sound
SOLUX PTY LTD
BOS Balance of Storage Systems AG
OJ Electronics A/S
TVS Motor Company Ltd.
core sensing GmbH
Tamblue Oy
Protect Animals With Satellites LLC
Tyromotion GmbH
ElectronX design

Thule Group AB


KEEPEN
Rocky Mountain ATV/MC Jake Wilson
MakuSafe Corp
Bartec Auto Id Ltd
Energy Technology and Control Limited
doubleO Co., Ltd.
Datalogic S.r.l.
Datalogic USA, Inc.
Leica Geosystems AG
CATEYE Co., Ltd.
Research Products Corporation
Planmeca Oy
C.Ed. Schulte GmbH Zylinderschlossfabrik
PetVoice Co., Ltd.
Timebirds Australia Pty Ltd
JVC KENWOOD Corporation

Spartek Systems Inc.
MERRY ELECTRONICS CO., LTD.
Merry Electronics (S) Pte Ltd
Spark
Nations Technologies Inc.
Akix S.r.l.
Bioliberty Ltd
C.G. Air Systemes Inc.
Maturix ApS
RACHIO, INC.
LIMBOID LLC
Electronics4All Inc.
FESTINA LOTUS SA
Synkopi, Inc.
SCIENTERRA LIMITED
Cennox Group Limited
Cedarware, Corp.
GREE Electric Appliances, Inc. of Zhuhai
Japan Display Inc.
System Elite Holdings Group Limited
Burkert Werke GmbH & Co. KG
velocitux
FUJITSU COMPONENT LIMITED
MIYAKAWA ELECTRIC WORKS LTD.
PhysioLogic Devices, Inc.
Sensoryx AG
SIL System Integration Laboratory GmbH
Cooler Pro, LLC
Advanced Electronic Applications, Inc
Delta Development Team, Inc
Laxmi Therapeutic Devices, Inc.
SYNCHRON, INC.
Badger Meter
Micropower Group AB
ZILLIOT TECHNOLOGIES PRIVATE LIMITED
Universidad Politecnica de Madrid
XIHAO INTELLIGENGT TECHNOLOGY CO., LTD
Zerene Inc.
CycLock

Frost Solutions, LLC
Lone Star Marine Pty Ltd
SIRONA Dental Systems GmbH
bHaptics Inc.
LUMINOAH, INC.
Vogels Products B.V.
SignalFire Telemetry, Inc.
CPAC Systems AB
TEKTRO TECHNOLOGY CORPORATION
Gosuncn Technology Group Co., Ltd.
Ex Makhina Inc.
Odeon, Inc.
Thales Simulation & Training AG
Shenzhen DOKE Electronic Co., Ltd
Vemcon GmbH
Refrigerated Transport Electronics, Inc.
Rockpile Solutions, LLC
Soundwave Hearing, LLC

Optec, LLC
NIKAT SOLUTIONS PRIVATE LIMITED
Movano Inc.
NINGBO FOTILE KITCHENWARE CO., LTD.
Genetus inc.
DIVAN TRADING CO., LTD.
Luxottica Group S.p.A
ISEKI FRANCE S.A.S
NO CLIMB PRODUCTS LTD
Wellang.Co,.Ltd
Nanjing Xinxiangyuan Microelectronics Co., Ltd.
ifm electronic gmbh
HYUPSUNG MACHINERY ELECTRIC CO., LTD.
Gunnebo Aktiebolag
Axis Communications AB

Stogger B.V.
Pella Corp
SiChuan Homme Intelligent Technology co.,Ltd.
Smart Products Connection, S.A.
F.I.P. FORMATURA INIEZIONE POLIMERI - S.P.A.
MEBSTER s.r.o.
SKF France
Southco
Molnlycke Health Care AB
Hendrickson USA , L.L.C
BLACK BOX NETWORK SERVICES INDIA PRIVATE LIMITED
Status Audio LLC
AIR AROMA INTERNATIONAL PTY LTD
Helge Kaiser GmbH
Crane Payment Innovations, Inc.

DYNAMOX S/A
Look Cycle International
Closed Joint Stock Company NVP BOLID
Kindhome
Kiteras Inc.
Earfun Technology (HK) Limited
iota Biosciences, Inc.
ANUME s.r.o.
Indistinguishable From Magic, Inc.
i-focus Co.,Ltd
DualNetworks SA
MITACHI CO.,LTD.
VIVIWARE JAPAN, Inc.
Xiamen Intretech Inc.
MindMaze SA
BeiJing SmartChip Microelectronics Technology Co.,Ltd
Taiko Audio B.V.
Daihatsu Motor Co., Ltd.
Konova
Gravaa B.V.
Beyerdynamic GmbH & Co. KG
VELCO
ATLANTIC SOCIETE FRANCAISE DE DEVELOPPEMENT THERMIQUE
Testo SE & Co. KGaA
SEW-EURODRIVE GmbH & Co KG
ROCKWELL AUTOMATION, INC.
Quectel Wireless Solutions Co., Ltd.

Nanohex Corp
Simply Embedded Inc.
Software Development, LLC
Ultimea Technology (Shenzhen) Limited
RF Electronics Limited
Optivolt Labs, Inc.
Canon Electronics Inc.
LAAS ApS
Beamex Oy Ab
TACHIKAWA CORPORATION
HagerEnergy GmbH

Hunter Industries Incorporated
NEOKOHM SISTEMAS ELETRONICOS LTDA
Zhejiang Huanfu Technology Co., LTD
E.F. Johnson Company
Caire Inc.
Yeasound (Xiamen) Hearing Technology Co., Ltd
Boxyz, Inc.
Skytech Creations Limited
Cear, Inc.
Impulse Wellness LLC
MML US, Inc
SICK AG
Fen Systems Ltd.
KIWI.KI GmbH
Airgraft Inc.
HP Tuners
PIXELA CORPORATION
Generac Corporation
Novoferm tormatic GmbH
Airwallet ApS
Inventronics GmbH
Shenzhen EBELONG Technology Co., Ltd.
Efento
ITALTRACTOR ITM S.P.A.

TITUM AUDIO, INC.
Hexagon Aura Reality AG
Invisalert Solutions, Inc.
TELE System Communications Pte. Ltd.
Whirlpool
SHENZHEN REFLYING ELECTRONIC CO., LTD
Franklin Control Systems
Djup AB
SAFEGUARD EQUIPMENT, INC.
Morningstar Corporation
Shenzhen Chuangyuan Digital Technology Co., Ltd
CompanyDeep Ltd
Veo Technologies ApS
Nexis Link Technology Co., Ltd.
Felion Technologies Company Limited
MAATEL
HELLA GmbH & Co. KGaA
HWM-Water Limited
Shenzhen Jahport Electronic Technology Co., Ltd.
NACHI-FUJIKOSHI CORP.
Cirrus Research plc
GEARBAC TECHNOLOGIES INC.
Hangzhou NationalChip Science & Technology Co.,Ltd
DHL
Levita
MORNINGSTAR FX PTE. LTD.
ETO GRUPPE TECHNOLOGIES GmbH
farmunited GmbH
Aptener Mechatronics Private Limited
GEOPH, LLC
Trotec GmbH
Astra LED AG
NOVAFON - Electromedical devices limited liability company
KUBU SMART LIMITED
ESNAH
OrangeMicro Limited
Fresh n Rebel B.V.
Global Satellite Engineering
KOQOON GmbH & Co.KG
BEEPINGS
MODULAR MEDICAL, INC.
Xiant Technologies, Inc.

SCHELL GmbH & Co. KG
Minebea Intec GmbH
KAGA FEI Co., Ltd.
AUTHOR-ALARM, razvoj in prodaja avtomobilskih sistemov proti kraji, d.o.o.
Tozoa LLC
SHENZHEN DNS INDUSTRIES CO., LTD.
Shenzhen Lunci Technology Co., Ltd
KNOG PTY. LTD.
Outshiny India Private Limited
TAMADIC Co., Ltd.
Shenzhen MODSEMI Co., Ltd
EMBEINT INC
Ehong Technology Co.,Ltd
DEXATEK Technology LTD
Dendro Technologies, Inc.
Vivint, Inc.
General Laser GmbH
Kathrein Solutions GmbH
Fitz Inc.
ATEGENOS PHARMACEUTICALS INC
Flextronic GmbH
Safety Swim LLC
SING SUN TECHNOLOGY (INTERNATIONAL) LIMITED
Woncan (Hong Kong) Limited
iFLYTEK (Suzhou) Technology Co., Ltd.
Weber-Stephen Products LLC
hDrop Technologies Inc.
REEKON TOOLS INC.
Delta Faucet Company
Mutrack Co., Ltd
Hangzhou Zhaotong Microelectronics Co., Ltd.
Chengdu CSCT Microelectronics Co., Ltd.
Belusun Technology Ltd.
Shenzhen Matches IoT Technology Co., Ltd.
Beidou Intelligent Connected Vehicle Technology Co., Ltd.
SOJI ELECTRONICS JOINT STOCK COMPANY
BH Technologies
Haptech, Inc.
WaveRF, Corp.
SHENZHEN SOUNDSOUL INFORMATION TECHNOLOGY CO.,LTD
Wuhu Mengbo Technology Co., Ltd.
PROSYS DEV LIMITED
Shenzhen eMeet technology Co.,Ltd
Doro AB
SUREPULSE MEDICAL LIMITED
iodyne, LLC
Pinpoint GmbH
Heinrich Kopp GmbH
Evolutive Systems SL

Sounding Audio Industrial Ltd.
Yuanfeng Technology Co., Ltd.
FrontAct Co., Ltd.

SenseWorks Tecnologia Ltda.
Eko Health, Inc.
Wanzl GmbH & Co. KGaA
CLEVER LOGGER TECHNOLOGIES PTY LIMITED
ASYSTOM
Heilongjiang Tianyouwei Electronics Co.,Ltd.
Eastern Partner Limited
Xiamen RUI YI Da Electronic Technology Co.,Ltd
Ad Hoc Electronics, llc.
Hangzhou Microimage Software Co.,Ltd.
Hive-Zox International SA
Sensovo GmbH
Time Location Systems AS
SHENZHEN DIGITECH CO., LTD
Capte B.V.
9512-5837 QUEBEC INC.
Blecon Ltd
CFLAB TEKNOLOJI TICARET LIMITED SIRKETI
FOGO
HITO INC
MS kajak7 UG (limited liability)
Avedis Zildjian Co.
Hangzhou Hikvision Digital Technology Co., Ltd.
LIHJOEN SPEED METER CO., LTD.
NextSense, Inc.
PatchRx, Inc.
Flipper Devices Inc.
Huizhou Foryou General Electronics Co., Ltd.
JE electronic a/s
9313-7263 Quebec inc.
ECARX (Hubei) Tech Co.,Ltd.
NIHON KOHDEN CORPORATION
ONWI
Primax Electronics Ltd.
AlphaTheta Corporation
PACIFIC INDUSTRIAL CO., LTD.
Crescent NV
Vermis, software solutions llc
SNAPPWISH LLC
Cousins and Sears LLC
CESYS Gesellschaft für angewandte Mikroelektronik mbH
SLOC GmbH
IRES Infrarot Energie Systeme GmbH
OFIVE LIMITED
Swift IOT Tech (Shenzhen) Co., LTD.
Viselabs
Walmart Inc.
VANBOX
Wiser Devices, LLC
WKD Labs Ltd
Asustek Computer Inc.
Z-ONE Technology Co., Ltd.
InnoVision Medical Technologies, LLC
QUANTATEC
Filo Srl
SOUNDUCT
Hosiden Besson Limited
KARLUNA MUHENDISLIK SANAYI VE TICARET ANONIM SIRKETI
Deone (Shanghai) Communication & Technology Co., Ltd
Nitto Denko Corporation
PUDSEY DIAMOND ENGINEERING LIMITED
Luxshare Precision Industry Co., Ltd.
Brooksee, Inc.
QSC, LLC
eBet Gaming Sytems Pty Limited
Zhejiang Desman Intelligent Technology Co., Ltd.
Dyaco International Inc.
Aquana, LLC
MINIRIG
After Technologies AS
New Cosmos Electric Co., Ltd.
INEPRO Metering B.V.
Altina Inc.
Urban Armor Gear, LLC
Loewe Technology GmbH
OmniWave Microelectronics Shanghai Co., Ltd
Wuhu Hongjing Electronic Co.,Ltd
Rocoto Ltd
L.T.H. Electronics Limited
SHAPER TOOLS, INC.
Ruptela
Ant Group Co., Ltd.
Queclink Wireless Solutions Co., Ltd.
GOKI PTY LTD
LAST LOCK INC.
HuiTong intelligence Company Limited
Daikin Industries, LTD
Shenzhen Baseus Technology Co., Ltd.
NEXT DEVICES LTDA

Megatronix (Beijing) Technology Co., Ltd
Hyena Inc.
Shenzhen Goodocom Information Technology Co., Ltd.
RIGH, INC.


OpConnect, Inc.
Powerstick.com
ENABLEWEAR LLC

Adventures of the Persistently Impaired (and other tales) Limited
Rocky Radios LLC
Le Touch (Shenzhen) Electronics Co., Ltd.
Guangdong Nanguang Photo&Video Systems Co., Ltd.
MOBILE TECH, INC.
HONG KONG COMMUNICATIONS COMPANY LIMITED
Neptune First OU
Vivago Oy
Circular
final Inc.
Jiangsu XinTongda Electric Technology Co.,Ltd.
Archon Controls LLC
SZR-Dev UG
IQNEXXT Solutions GmbH
Guangdong Hengqin Xingtong Technology Co.,ltd.
CHEVALIER TECH LIMITED
SPRiNTUS GmbH
Tymphany HK Ltd
TigerLight, Inc.
Mercury Marine, a division of Brunswick Corporation
OpenTech Alliance, Inc.
Skewered Fencing, LLC
Brudden
Tele-Radio i Lysekil AB
Allgon AB
Gopod Group Holding Limited
Celebrities Management Private Limited
Nobest Inc
Avetos Design LLC
RainMaker Solutions, Inc.
Identita Inc.
Glutz AG
MIV ELECTRONICS, LTD
Tactrix
Viaanix, Inc.
Skeed,co,Ltd.
kokoromil Inc.
Chromatic Inc.
Medibound, Inc.
Scanbro OU
Panasonic Automotive Systems Co., Ltd.
Andrews & Arnold Ltd
Audinor ApS
Travelxp India Private Limited
Owlet Baby Care Inc.
ENLESS WIRELESS
Culligan International Company
QIKCONNEX LLC
OLIS ELECTRONICS, LLC
BiTECH Automotive (Wuhu) Co.,Ltd

AMG Lab LLC
BrickXter GmbH
Dongguan Trangjan Industrial Co., Ltd
Makichie Co., Ltd.

STEYR Sport GmbH
Dynetrex Solutions Inc.
OPTRON Co., Ltd.
BHClears Microelectronics (Shanghai) Co., Ltd.
Unfolded Circle ApS
FactorySense
WearNex Limited
PRADCO Outdoor Brands
Zucchetti Axess
BLUEFIN DATA, LLC
Preseed Japan Corporation
Server Products, Inc.
Embedded Solutions LLC


THERMY LTD
Asahi Denso Co.,Ltd.
GP Acoustics International Limited
Tongfang Health Technology (Beijing) Co., Ltd.
Deity Acoustic Technology Co.
Schulte-Schlagbaum AG
WEST inx Ltd.
Crossdoor
High Entropy, LLC
Herschel Infrared Ltd
PACIFIC MARINE BATTERIES PTY. LIMITED
Alibaba (China) Co., Ltd.
AuthGate B.V.
Canyon Bicycles GmbH
Codie LLC
NeuroPace Inc
NexRev LLC
Zhong Shan City Richsound Electronic Industrial Ltd.
Shenzhen NEOECO Technology Co., Ltd.
Nature Inc.
Guangzhou Honor Microelectronic Co.,Ltd.
GGEC America, Inc.
Gibson, Inc.
VINYL MATT MEDIA LIMITED
SHENZHEN BESTWAY ELECTRONICS CO.,LTD
Lichens Innovation inc.
Goerdyna Group Co., Ltd
Relish Technologies Limited
Quintessential Design, Inc.
CS INSTRUMENTS GmbH & Co.KG
DORAN MFG. LLC
Overhead Door Corporation
Kodira GmbH
ShenZhen BoYiChuangXin
Shenzhen Zoqin Technology Co., Ltd.
Ceridwen Limited
Sony Honda Mobility Inc.
Dynaudio A/S
MAERSK CONTAINER INDUSTRY A/S
MA MICRO LIMITED
shenzhen hongever technology Co,. Ltd
TAMRON Co., Ltd.
CAPTEMP, LDA
Ambient Life Inc.
NOCTRIX HEALTH, INC
RICKARD AIR DIFFUSION (PTY) LTD
SG Armaturen AS
PIXEL TI IND. E COM PROD ELETRONICOS
Core Devices LLC
Fujita Electric Works, Ltd
Willow Laboratories, Inc.
BBC Bircher AG
ELLEA INGEGNERIA SRL UNIPERSONALE
Q42 Internet B.V.
Seaward Electronic
Wuxi Does IOT Co., Ltd

Monil AS

LS ELECTRIC Co., Ltd.
Shenzhen Cyber Innovation Technology Co., Ltd.
Trackonomy Systems, Inc.
IoT Solutions Malta Limited
Aseptico, Inc.
Sensear Pty Ltd
BLUEPROVIDERZ LLC
Jano Life Inc.
PRIMES GmbH
Teledyne Instruments, Inc.
Healthcare Technology Limited
TRACERCO LIMITED
HAPPLABS SOFTWARE PRIVATE LIMITED
GE HEALTHCARE TECHNOLOGIES INC.
Olibra LLC
Lumen Labs (HK) Ltd
SHENZHEN GWSTAI TECHNOLOGY CO.,LTD
SHENZHEN POWEROAK NEWENER CO., LTD
Tech OVN Private Limited
Lezyne USA Inc.
ANC CHINA LIMITED
LION GROUP, INC.
Brightway Innovation Intelligent Technology (Suzhou) Co., Ltd.
Hitachi Industrial Equipment Systems Co.,Ltd.
Maennl Elektronik GmbH
IDEATRONIK Limited Liability Company
caive Inc.
ShenZhen Doctors of Intelligence & Technology Co.,Ltd
Deep and Steep LLC
Endur ID, Inc.
Freshape SA
PreEvnt, LLC
Oval Corporation
ADHD Friendly co.Ltd
RORENTECH Co., Ltd.
iKeyless, LLC
Shenzhen SuperSound Technology Co.,Ltd
FLO SCIENCES, LLC
PalatiumCare LLC
Edge Semiconductors Inc.
ZIMMERMANN PV-Steel Group GmbH & Co. KG
Yolni Inc.
Ninebot (Changzhou) Tech Co., Ltd.
Beijing Spring Creation Technology Co., Ltd.
Rokk Limited
ONESPACE TECHNOLOGIES (PTY) LTD
Yuquan Semiconductor (Xiamen) Co., Ltd.
Easy Measure Co., Ltd.
Sichuan Changhong Neonet Technologies Co.,Ltd.
Centromere Holding B.V.
Global Link Distribution Corp.
Amp Fit Israel LTD
Trezor Company s.r.o.
KELLER Druckmesstechnik AG
ElitEngineering LLC
Vision Group Inc.
ClipsClips LLC
BRITZ INTERNATIONAL CO.,LTD
ThingCo Limited
Opal Camera, Inc.
TECHNOLOGIES FOR FREERIDE s.r.o
FLINTEC UK LIMITED
TETNET
NINGBO SHARKWARD ELECTRONICS CO.,LTD
Audeze LLC
NODER Joint Stock Company
Schueco International KG
GILL INSTRUMENTS LIMITED
Seitron Spa
Southern Audio Services, Inc
SANWA NEWTEC CO.,LTD.
Mobile Technology Solutions LLC
Vitio Medical S.L.
Salyx Medical Inc.
Landig + Lava GmbH & Co. KG
Health Data Insight C.I.C.
BONX INC.
LINKEDCHIP TECHNOLOGY INC
12mm Health Technology (Hainan) Co., Ltd.
MAVERICK ENERGY SOLUTIONS INTERNATIONAL,INC
Tactica Defense LLC
Huizhou Meicanxin Electronics Technology Co.,Ltd
Lodestar Technology Inc.

IYO INC.
Mitsubishi Motors Corporation
desamisCo.,Ltd.
JL WORLD CORPORATION LIMITED
Qulinda AB
Ningbo Dooya Mechanic & Electronic Technology Co., Ltd
G-Vision GmbH
Lantern Innovations Incorporated
ebm-papst Mulfingen GmbH & Co. KGaA & Co. KG
Shenzhen Yunke Intelligent Co.Ltd
Fledt & Meiton Marin AB
ContiTech Deutschland GmbH
Sensoteq Ltd
Astute Access Group Limited
Silverlake Technologies
Shenzhen Guo-link Technology Co.,Ltd.
Silicon Vandals PTY LTD
Vibe Energy B.V.
shanghai fudan electronics group company Co. Ltd
Micro Technology Services, Inc.
Leapcraft ApS
WUXI WEIDA INTELLIGENT ELECTRONICS CO.,LTD.
ROBSON SRL

HyolimXE Co., Ltd.
Kehwin Technologies Co. Ltd.
WATTER, Inc.
SafeNow GmbH
CZV, Inc
BIGREDBEE, LLC
White Eagle Sonic Technologies, Inc.
Navico
Ancoe Industry Corporation
Roam Devices LLC
Skywalk Inc.
Biogents AG
MODRETRO, INC.
iSi Wearable Safety GmbH
onanoff limited
TECHFLITTER SOLUTIONS PRIVATE LIMITED
PIRITIZ LLC
FLORLINK, INC.
Keycafe Inc.
Sperry Labs LLC
Senseonics, Incorporated
simatec ag
CROSS BRAIN CO.,Ltd.
Also, Inc.
Walter Mueller Inc. for Industrial Electronics
SHENZHEN GUANG QI GUO CHUANG TECHNOLOGY CO.,LTD
SKYROAM, INC.
Polk Audio
eQ-3 AG
shenzhen Holyiot Technology Co.,Ltd
Badass eBikes GmbH
Hydro Electronic Devices, Inc.
IN Phase International lTD
Amon Co.Ltd.
Calpeda S.p.A.
KT Micro, Inc.
Hangzhou Sciener Smart Technology Co., Ltd.
Lakecrest Pty Ltd
Anacove Inc.
Kohler Ventures, Inc.
STOREIO TECHNOLOGIES LTD
Innogando S.L.
A.Y. McDonald Mfg. Co.
ROYAL PARTS CO.,LTD
JUREN CO., LTD.
Biceek Inc
SIGNUM INTELLIGENCE LTD
MOBI7 TECNOLOGIA EM MOBILIDADE S.A.
Valostra Digital Ventures LLP
Ethos Group, Inc.
Aktiebolaget Ebeco
IDX Company, Ltd.
Dongguang Huasoo Automation Technology Company Limited
SEIKOIST, INC
SPX Aids to Navigation Oy
Fitnexa Inc
DEZINE GROUP LLC
Eiritsu Electronics Industry Co., Ltd.
Hanshow Technology Co.,Ltd.
WePower Technologies LLC
IRTrans GmbH
Hibino Corporation
Seiko Future Creation Inc.
DP IOT
PALRED RETAIL PRIVATE LIMITED
BIA NEUROSCIENCE INC.
B.E.G. Brueck Electronic GmbH
Nice Spa
Avanos Medical, Inc.
Ugreen Group Limited
spheretek japan
Senti Technologies Private Limited
Ranch Systems, Inc.
Suzhou Fanxi Technology Co., Ltd.
Geo Radar AI Private Limited
Flitsmeister B.V.
The AI Toy Company
Capacite
Terasite Technologies
General Resistance, LLC
Avivomed Inc.
PLAUD Inc.
Hooked Society Oy Ltd
StoneDevices
Hangzhou Nano IC Technologies Co,. Ltd
TQ-Systems GmbH
Hapn Holdings, LLC
SITERWELL ELECTRONICS CO.,LIMITED
Shenzhen Mutual Technology Co., Ltd
Cosonic Intelligent Technologies Co., Ltd.
Rollease Acmeda, Inc.
ATANS TECHNOLOGY INC.
Locus Robotics Corp.
TaigaIoT
Tridentify AB
Littlebird Connected Care, Inc.
Air Automotive tracking Inc.
ISSPRO, INC
Shenzhen Jimi loT Co.,Ltd
FulScience Automotive Electronics Co., Ltd.
Hypershell Co., Ltd
ASD Lighting PLC
Pharox B.V.
Eforthink Technology Co., Ltd.
Zirbel Bike GmbH
Legato Audio, Inc.
Biocorp Production
Neurotherapeutics Ltd
Wimate Technology Solutions Pvt Ltd
NOJA Power
Nestlab AS
Stark Future SL
Auranova LLC
Domteknika S.A
YDIIT Co., Ltd
QRITAGYA LLP
Telemacy Ltd
LIOTYS
Hondata, Inc.
SIVA Inotec Limited
REMDEVICE S.R.L.
NIVELCO PROCESS CONTROL CO.

Beijing Hongsi Electronic Technology Co.,Ltd.





























































































FOSS Analytical A/S


Blahaj Ltd
Nextorage Corporation
infyni
Raspberry Pi
Shenzhen Huasheng Jiaye Technology Co., Ltd
Namara Water Technologies, Inc
Shanghai Holychip Electronic Co., Ltd.
Rotarex S.A.
VOTRONIC Elektronik-Systeme GmbH
EXELIO S.R.L.
Yamaha Motor eBike Systems GmbH
Ferrari s.p.a.
Anhui Ubico Advanced Manufacture Co., Ltd.
Mueller-BBM Rail Technologies GmbH
Yoto Limited
LAUMAS Elettronica S.r.l.
BUND MEDIA PTY. LTD.
LSC Control Systems Pty Ltd
Safety Lighting Research Pty Ltd
Hangzhou Sneuro Medical Co., Ltd.
UnlimitedIRL LLC
CHOZEN International CO., LTD.
Sensorworx, Inc.
Romcor Pty Ltd
NewNet, Inc.
CLM-Solutions
RSA Security LLC
Gravity (Shenzhen)Space Technology Co., Ltd
Shenzhen Shuye Technology Co.,Ltd.
ArjoHuntleigh AB
Fairbanks Scales Inc.
YANMAR HOLDINGS CO., LTD.
Williams Sound, LLC
Zuuka Limited
Chip-pump Microelectronics
TOMOE VALVE CO.,LTD
VCS Vision Control Solutions GmbH
Framason Audio S.A
Field Line Automation Ltd
Shearwater Research Inc.
HIGH HIT ENTERPRISE CO., LTD.
Algiz AS
Shenzhen FHX Precision Hardware & Plastic Co., Ltd.
Hotron Co., Ltd.
Remoticom B.V.
OSKEY
GORDON MURRAY GROUP LIMITED
Global Electronics
Rokstar Holdings Limited
STRYDE LIMITED
Prosaris Solutions Ltd.
TLV Co.,LTD.
IZYBAT
ALTESSA SOLUTIONS INC.
Hong Kong Future lntelligent Technology Co., Limited
CenTrak, Inc.
TM-TECHNOLOGIES, JSC
ALPHADIF
Shenzhen Muyu Technology Co., Ltd.
augment AI Inc.
Digimax Innovative Products LTD.
CodaHD LLC
E.J. Brooks Company
Martin.Care GmbH
IMPACT-BZ LTD
Belford investment holdings pty ltd
Anton Paar ConsumerTec GmbH
Knit Sound Company
Australis Scientific Pty Ltd.
AIR PRODUCTS AND CHEMICALS, INC.
SYSTEM LOCO LTD
24x8, LLC
FUTURE INTELLIGENCE TECHNOLOGY SINGAPORE PTE. LTD.
M3SH TECHNOLOGY INC.
Matisse Interactif inc.
Sesame AI, Inc.
DEER MANAGEMENT SYSTEMS, LLC
Grayhill Inc.
PERUN TECH SP. Z O.O.
Tiny Displays Inc.
DEWINE Labs GmbH
Industrial Computing Limited
SkyCell AG
NAGANO KEIKI CO., LTD.
COSEL ELEKTRONIK OTOMASYON SISTEMLERI SANAYI VE TICARET LIMITED SIRKETI
BXB DIGITAL PTY LIMITED
Mindspire Limited
Personal Products Co., Ltd.
CardiaMetrics
Aktv8 LLC
Knox Associates, Inc.
smart-TEC GmbH & Co. KG
Selco GmbH
MONNIT CORPORATION
Tensoli GmbH
KIBLE
terumo
SHIBAURA ELECTRONICS CO., LTD.
Shenzhen Hali-Power Industrial Co., Ltd.
inContAlert GmbH
flexlog GmbH
Audio Research Corporation
BQT Solutions (NZ) Limited
RAPIDISE TECHNOLOGY PRIVATE LIMITED
Cebreo Medical A/S
Lightnovo ApS
Pedigree Technologies, LLC
Zhejiang Wanyou Intelligent Technology Co., Ltd.
Mallow
Sigenergy Technology Co., Ltd.
ObjectSpectrum, LLC
ATsens Co.,Ltd.
CoreHW Semiconductor Oy
Raycon Inc.
Hangzhou SDIC Microelectronics Inc.
VSC Synapse LLC
Senops Tracker, LLC
Shenzhen Xunzong Zhilian Technology Co., Ltd.
HOSEOTELNET Co., Ltd.
Solabs Technology (HK) Co., Limited
SpartanLync Technologies Corp.
SHENZHEN CHINA MICRO SEMICON CO.,LIMITED
Fosilicon Co., Ltd
Palarum LLC
CYNC Labs, Inc.
Noble HiFi, LLC
VERGESENSE INC
Harley-Davidson Motor Company
Variowell Development GmbH
UNIVERSAL REMOTE CONTROL, INC.
All Inspire Health, Inc.
Minda Corporation Ltd
Shenzhen ECO-NEWLEAF CO., LTD
SainStore Technology Co., Ltd.
TECH FASS s.r.o.
OPICA GmbH
Cardinal Scale Mfg
Piscisea Tech Inc
CHIYODA TECHNOL CORPORATION
mylife Diabetes Care AG
Tractian Technologies Inc.
FairPhone B.V
The90, Inc.
Linde GmbH
Kumho Tire
Inito Health Inc.
Tempur World, LLC
Band24, LLC
Acer Inc.
Hehku Company Oy
AGCO Corporation
Victor Hasselblad AB
IntelliDesign Pty Ltd
UltronSMART Inc.
Arashi Vision Inc.
Westfalen Aktiengesellschaft
Liebherr-Hausgeraete GmbH
SKAIChips Co.,Ltd
SZ Avinox Innovation Co., Ltd.
Spectra Precision (Kaiserslautern) GmbH
Triumph Designs Ltd
Gastron Co.,Ltd
Hawkeye Surgical Lighting LLC
Arnold & Richter Cine Technik GmbH & Co. Betriebs KG
Neurable, Inc
CAREHAWK INC.
Vybe Audio LLC
Smart Technologies ULC
Durin, inc.
KWANG YANG MOTOR CO., LTD.
Placenet Internet of Places S.L.
Liontron GmbH & Co. KG
Hankook Tire & Technology Co., Ltd.
Guangdong Youhong Medical Technology Co.,Ltd
Fontaine Fifth Wheel Company
ZELP LTD
BRITA SE
Shanghai XYLink Limited Corporation
Keto-Check Inc.
RFID N PRINT PTY LTD
Ralston Instruments, LLC
CHIGEE TECHNOLOGY CO., LTD.
EURODIMA GmbH & CoKG
SUPERARK LTD
Shenzhen DeepX Technology Co., Ltd.
Pressure Systems International, Inc.
HEX INNOVATE (UK) LIMITED
IONLINE INTERNET SERVICE PROVIDER
Even Realities Ltd.
QPlay Ltd
Hydratune Australia Pty Ltd
CITECH CO.,LTD.
Neurabody Inc.
Daisen Electronic Industrial Co., Ltd.
Sonus Faber spa
miThings
Nearfaces UG (haftungsbeschränkt)
Temple Private Limited
BRISANT SECURE LTD
Daiichi Elektronik Sanayi ve Ticaret. A.S.
Cirrus Design Corporation
Flicfit inc.
Optrel AG
BEMER Int. AG
Hamodaz Corporation
OnRace Motorsports
SIGMA CORPORATION
rescuetrack GmbH
ARETA AI INC.
Gigawit Electronics LTD
Nylint, LLC
Hamaton Inc.,
RAPSODO PTE. LTD.
JustTec GmbH
ONXMAPS, INC
Metabowerke GmbH
Thermia Aktiebolag
ALLRA LIMITED`.split(/\r?\n/);

	// What a service is: its 16-bit number, or its whole UUID, and its name
	var SERVICES = `1800 Generic Access
1801 Generic Attribute
1802 Immediate Alert
1803 Link Loss
1804 Tx Power
1805 Current Time Service
1806 Reference Time Update Service
1807 Next DST Change Service
1808 Glucose
1809 Health Thermometer
180A Device Information
180D Heart Rate
180E Phone Alert Status Service
180F Battery Service
1810 Blood Pressure
1811 Alert Notification Service
1812 Human Interface Device
1813 Scan Parameters
1814 Running Speed and Cadence
1815 Automation IO
1816 Cycling Speed and Cadence
1818 Cycling Power
1819 Location and Navigation
181A Environmental Sensing
181B Body Composition
181C User Data
181D Weight Scale
181E Bond Management Service
181F Continuous Glucose Monitoring
1820 Internet Protocol Support Service
1821 Indoor Positioning
1822 Pulse Oximeter Service
1823 HTTP Proxy
1824 Transport Discovery
1825 Object Transfer Service
1826 Fitness Machine
1827 Mesh Provisioning Service
1828 Mesh Proxy Service
1829 Reconnection Configuration
183A Insulin Delivery
183B Binary Sensor
183C Emergency Configuration
183E Physical Activity Monitor
1843 Audio Input Control
1844 Volume Control
1845 Volume Offset Control
1846 Coordinated Set Identification
1847 Device Time
1848 Media Control
1849 Generic Media Control
184A Constant Tone Extension
184B Telephone Bearer
184C Generic Telephone Bearer
184D Microphone Control
184E Audio Stream Control
184F Broadcast Audio Scan
1850 Published Audio Capabilities
1851 Basic Audio Announcement
1852 Broadcast Audio Announcement
1853 Common Audio
1854 Hearing Access
1855 Telephony and Media Audio
1856 Public Broadcast Announcement
1857 Electronic Shelf Label
1858 Gaming Audio
1859 Mesh Proxy Solicitation
185B Ranging Service (RAS)
1860 Tire Pressure Monitoring System Service
FCB2 Location Enabled Advertisement Service
FD0D Blecon Advertising Service
FD6F Exposure Notification Service
FE0F Signify Netherlands B.V. (formerly Philips Lighting) Service
FE2C Fast Pair Service
FE59 Secure DFU Service
FEAA Eddystone
FEBB File Transfer Service by Adafruit
00001523-1212-EFDE-1523-785FEABCD123 Nordic LED and Button Service
00001530-1212-EFDE-1523-785FEABCD123 Legacy DFU Service
00001623-1212-EFDE-1623-785FEABCD123 LEGO® Wireless Protocol v3 Hub Service
00001625-1212-EFDE-1623-785FEABCD123 LEGO® Wireless Protocol v3 Bootloader Service
0483DADD-6C9D-6CA9-5D41-03AD4FFF4ABB Nordic Throughput Service
0FDA92B2-44A2-4AF2-84F5-FA682BAA2B8D Helium Hotspot Custom Service
14387800-130C-49E7-B877-2881C89CB258 Nordic Wi-Fi Provisioning Service
21490000-494A-4573-98AF-F126AF76F490 Nordic Direction and Distance Finding Service
54220000-F6A5-4007-A371-722F4EBD8436 Memfault Diagnostic Service
57A70000-9350-11ED-A1EB-0242AC120002 Nordic Status Message Service
6E400001-B5A3-F393-E0A9-E50E24DCCA9E Nordic UART Service
7905F431-B5CE-4E99-A40F-4B1E122D00D0 Apple Notification Center Service
7DFC6000-7D1C-4951-86AA-8D9728F8D66C Apple Reserved Service
7DFC7000-7D1C-4951-86AA-8D9728F8D66C Apple Reserved Service
7DFC8000-7D1C-4951-86AA-8D9728F8D66C Apple Reserved Service
7DFC9000-7D1C-4951-86AA-8D9728F8D66C Apple Reserved Service
89D3502B-0F36-433A-8EF4-C502AD55F8DC Apple Media Service
8D53DC1D-1DB7-4CD3-868B-8A527460AA84 SMP Service
8E400001-F315-4F60-9FB8-838830DAEA50 Experimental Buttonless DFU Service
932C32BD-0000-47A2-835A-A8D455B859DD Philips Hue Light Control Service
A3C87500-8ED3-4BDF-8A39-A01BEBEDE295 Eddystone Configuration Service
A5B46352-9D13-479F-9FCB-3DCDF0A13F4D Thingy Sensor Hub
ADAF0100-C332-42A8-93BD-25E905756CB8 Adafruit Temperature Service
ADAF0200-C332-42A8-93BD-25E905756CB8 Adafruit Accelerometer Service
ADAF0300-C332-42A8-93BD-25E905756CB8 Adafruit Light Service
ADAF0400-C332-42A8-93BD-25E905756CB8 Adafruit Gyroscope Service
ADAF0500-C332-42A8-93BD-25E905756CB8 Adafruit Magnetometer Service
ADAF0600-C332-42A8-93BD-25E905756CB8 Adafruit Button Service
ADAF0700-C332-42A8-93BD-25E905756CB8 Adafruit Humidity Service
ADAF0800-C332-42A8-93BD-25E905756CB8 Adafruit Barometric Service
ADAF0900-C332-42A8-93BD-25E905756CB8 Adafruit Addressable Service
ADAF0A00-C332-42A8-93BD-25E905756CB8 Adafruit Color Service
ADAF0B00-C332-42A8-93BD-25E905756CB8 Adafruit Sound Service
ADAF0C00-C332-42A8-93BD-25E905756CB8 Adafruit Tone Service
ADAF0D00-C332-42A8-93BD-25E905756CB8 Adafruit Quaternion Service
ADAF0E00-C332-42A8-93BD-25E905756CB8 Adafruit Proximity Service
B2007AAA-C203-43A5-8B6F-A7F3D001A1E0 QuickStart Service
B8843ADD-0000-4AA1-8794-C3F462030BDA Philips Hue Light Update Service
E2A00001-EC31-4EC3-A97A-1C34D87E9878 Edge Impulse Remote Management Service
E95D0753-251D-470A-A062-FA1922DFA9A8 micro:bit Accelerometer Service
E95D127B-251D-470A-A062-FA1922DFA9A8 micro:bit IO Pin Service
E95D6100-251D-470A-A062-FA1922DFA9A8 micro:bit Temperature Service
E95D93AF-251D-470A-A062-FA1922DFA9A8 micro:bit Event Service
E95D93B0-251D-470A-A062-FA1922DFA9A8 micro:bit DFU Control Service
E95D9882-251D-470A-A062-FA1922DFA9A8 micro:bit Button Service
E95DD91D-251D-470A-A062-FA1922DFA9A8 micro:bit LED Service
E95DF2D8-251D-470A-A062-FA1922DFA9A8 micro:bit Magnetometer Service
EF680100-9B35-4933-9B10-52FFA9740042 Thingy Configuration Service
EF680200-9B35-4933-9B10-52FFA9740042 Thingy Weather Station Service
EF680300-9B35-4933-9B10-52FFA9740042 Thingy UI Service
EF680400-9B35-4933-9B10-52FFA9740042 Thingy Motion Service
EF680500-9B35-4933-9B10-52FFA9740042 Thingy Sound Service
F000FFC0-0451-4000-B000-000000000000 Texas Instruments Over-the-Air Download (OAD) Service`;

	// 16-bit service numbers that are a company's own: whose
	var MEMBERS = `FCB2 Apple
FCF1 Google
FD59 Samsung
FD5A Samsung
FD69 Samsung
FD6F Apple
FD84 Tile
FDAB Xiaomi
FDF7 HP
FE03 Amazon
FE07 Sonos
FE0F Signify (Philips Hue)
FE25 Apple
FE26 Google
FE2C Google
FE33 Chipolo
FE59 Nordic Semiconductor
FE61 Logitech
FE65 Chipolo
FE78 HP
FE95 Xiaomi
FE9F Google
FEA0 Google
FEAA Google
FEB8 Meta
FEBE Bose
FEE0 Huami (Xiaomi's bands)
FEE7 Tencent
FEEC Tile
FEED Tile
FEF3 Google`;

	// What a device says it is: a category (the value's upper ten bits), or
	// category.kind within it (the lower six), and its name
	var LOOKS = `0 Unknown
1 Phone
2 Computer
2.1 Desktop Workstation
2.2 Server-class Computer
2.3 Laptop
2.4 Handheld PC/PDA (clamshell)
2.5 Palm-size PC/PDA
2.6 Wearable computer (watch size)
2.7 Tablet
2.8 Docking Station
2.9 All in One
2.10 Blade Server
2.11 Convertible
2.12 Detachable
2.13 IoT Gateway
2.14 Mini PC
2.15 Stick PC
3 Watch
3.1 Sports Watch
3.2 Smartwatch
4 Clock
5 Display
6 Remote Control
7 Eye-glasses
8 Tag
9 Keyring
10 Media Player
11 Barcode Scanner
12 Thermometer
12.1 Ear Thermometer
13 Heart Rate Sensor
13.1 Heart Rate Belt
14 Blood Pressure
14.1 Arm Blood Pressure
14.2 Wrist Blood Pressure
15 Human Interface Device
15.1 Keyboard
15.2 Mouse
15.3 Joystick
15.4 Gamepad
15.5 Digitizer Tablet
15.6 Card Reader
15.7 Digital Pen
15.8 Barcode Scanner
15.9 Touchpad
15.10 Presentation Remote
16 Glucose Meter
17 Running Walking Sensor
17.1 In-Shoe Running Walking Sensor
17.2 On-Shoe Running Walking Sensor
17.3 On-Hip Running Walking Sensor
18 Cycling
18.1 Cycling Computer
18.2 Speed Sensor
18.3 Cadence Sensor
18.4 Power Sensor
18.5 Speed and Cadence Sensor
19 Control Device
19.1 Switch
19.2 Multi-switch
19.3 Button
19.4 Slider
19.5 Rotary Switch
19.6 Touch Panel
19.7 Single Switch
19.8 Double Switch
19.9 Triple Switch
19.10 Battery Switch
19.11 Energy Harvesting Switch
19.12 Push Button
19.13 Dial
20 Network Device
20.1 Access Point
20.2 Mesh Device
20.3 Mesh Network Proxy
21 Sensor
21.1 Motion Sensor
21.2 Air quality Sensor
21.3 Temperature Sensor
21.4 Humidity Sensor
21.5 Leak Sensor
21.6 Smoke Sensor
21.7 Occupancy Sensor
21.8 Contact Sensor
21.9 Carbon Monoxide Sensor
21.10 Carbon Dioxide Sensor
21.11 Ambient Light Sensor
21.12 Energy Sensor
21.13 Color Light Sensor
21.14 Rain Sensor
21.15 Fire Sensor
21.16 Wind Sensor
21.17 Proximity Sensor
21.18 Multi-Sensor
21.19 Flush Mounted Sensor
21.20 Ceiling Mounted Sensor
21.21 Wall Mounted Sensor
21.22 Multisensor
21.23 Energy Meter
21.24 Flame Detector
21.25 Vehicle Tire Pressure Sensor
22 Light Fixtures
22.1 Wall Light
22.2 Ceiling Light
22.3 Floor Light
22.4 Cabinet Light
22.5 Desk Light
22.6 Troffer Light
22.7 Pendant Light
22.8 In-ground Light
22.9 Flood Light
22.10 Underwater Light
22.11 Bollard with Light
22.12 Pathway Light
22.13 Garden Light
22.14 Pole-top Light
22.15 Spotlight
22.16 Linear Light
22.17 Street Light
22.18 Shelves Light
22.19 Bay Light
22.20 Emergency Exit Light
22.21 Light Controller
22.22 Light Driver
22.23 Bulb
22.24 Low-bay Light
22.25 High-bay Light
23 Fan
23.1 Ceiling Fan
23.2 Axial Fan
23.3 Exhaust Fan
23.4 Pedestal Fan
23.5 Desk Fan
23.6 Wall Fan
24 HVAC
24.1 Thermostat
24.2 Humidifier
24.3 De-humidifier
24.4 Heater
24.5 Radiator
24.6 Boiler
24.7 Heat Pump
24.8 Infrared Heater
24.9 Radiant Panel Heater
24.10 Fan Heater
24.11 Air Curtain
25 Air Conditioning
26 Humidifier
27 Heating
27.1 Radiator
27.2 Boiler
27.3 Heat Pump
27.4 Infrared Heater
27.5 Radiant Panel Heater
27.6 Fan Heater
27.7 Air Curtain
28 Access Control
28.1 Access Door
28.2 Garage Door
28.3 Emergency Exit Door
28.4 Access Lock
28.5 Elevator
28.6 Window
28.7 Entrance Gate
28.8 Door Lock
28.9 Locker
29 Motorized Device
29.1 Motorized Gate
29.2 Awning
29.3 Blinds or Shades
29.4 Curtains
29.5 Screen
30 Power Device
30.1 Power Outlet
30.2 Power Strip
30.3 Plug
30.4 Power Supply
30.5 LED Driver
30.6 Fluorescent Lamp Gear
30.7 HID Lamp Gear
30.8 Charge Case
30.9 Power Bank
31 Light Source
31.1 Incandescent Light Bulb
31.2 LED Lamp
31.3 HID Lamp
31.4 Fluorescent Lamp
31.5 LED Array
31.6 Multi-Color LED Array
31.7 Low voltage halogen
31.8 Organic light emitting diode (OLED)
32 Window Covering
32.1 Window Shades
32.2 Window Blinds
32.3 Window Awning
32.4 Window Curtain
32.5 Exterior Shutter
32.6 Exterior Screen
33 Audio Sink
33.1 Standalone Speaker
33.2 Soundbar
33.3 Bookshelf Speaker
33.4 Standmounted Speaker
33.5 Speakerphone
34 Audio Source
34.1 Microphone
34.2 Alarm
34.3 Bell
34.4 Horn
34.5 Broadcasting Device
34.6 Service Desk
34.7 Kiosk
34.8 Broadcasting Room
34.9 Auditorium
35 Motorized Vehicle
35.1 Car
35.2 Large Goods Vehicle
35.3 2-Wheeled Vehicle
35.4 Motorbike
35.5 Scooter
35.6 Moped
35.7 3-Wheeled Vehicle
35.8 Light Vehicle
35.9 Quad Bike
35.10 Minibus
35.11 Bus
35.12 Trolley
35.13 Agricultural Vehicle
35.14 Camper / Caravan
35.15 Recreational Vehicle / Motor Home
36 Domestic Appliance
36.1 Refrigerator
36.2 Freezer
36.3 Oven
36.4 Microwave
36.5 Toaster
36.6 Washing Machine
36.7 Dryer
36.8 Coffee maker
36.9 Clothes iron
36.10 Curling iron
36.11 Hair dryer
36.12 Vacuum cleaner
36.13 Robotic vacuum cleaner
36.14 Rice cooker
36.15 Clothes steamer
37 Wearable Audio Device
37.1 Earbud
37.2 Headset
37.3 Headphones
37.4 Neck Band
38 Aircraft
38.1 Light Aircraft
38.2 Microlight
38.3 Paraglider
38.4 Large Passenger Aircraft
39 AV Equipment
39.1 Amplifier
39.2 Receiver
39.3 Radio
39.4 Tuner
39.5 Turntable
39.6 CD Player
39.7 DVD Player
39.8 Bluray Player
39.9 Optical Disc Player
39.10 Set-Top Box
40 Display Equipment
40.1 Television
40.2 Monitor
40.3 Projector
41 Hearing aid
41.1 In-ear hearing aid
41.2 Behind-ear hearing aid
41.3 Cochlear Implant
42 Gaming
42.1 Home Video Game Console
42.2 Portable handheld console
43 Signage
43.1 Digital Signage
43.2 Electronic Label
49 Pulse Oximeter
49.1 Fingertip Pulse Oximeter
49.2 Wrist Worn Pulse Oximeter
50 Weight Scale
51 Personal Mobility Device
51.1 Powered Wheelchair
51.2 Mobility Scooter
52 Continuous Glucose Monitor
53 Insulin Pump
53.1 Insulin Pump, durable pump
53.4 Insulin Pump, patch pump
53.8 Insulin Pen
54 Medication Delivery
55 Spirometer
55.1 Handheld Spirometer
81 Outdoor Sports Activity
81.1 Location Display
81.2 Location and Navigation Display
81.3 Location Pod
81.4 Location and Navigation Pod`;

	function table(text) {
		var t = {};
		text.split(/\r?\n/).forEach(function (l) {
			var i = l.indexOf(" ");
			if (i > 0) t[l.slice(0, i)] = l.slice(i + 1);
		});
		return t;
	}
	var services = table(SERVICES), members = table(MEMBERS), looks = table(LOOKS);
	function hex4(n) { return ("000" + n.toString(16)).slice(-4).toUpperCase(); }

	var api = {
		// The company with this number, or null
		company: function (code) { return COMPANIES[code] || null; },
		// The service with this 16-bit number, or this UUID (as text), or null
		service: function (uuid) {
			return services[typeof uuid === "number" ? hex4(uuid) : String(uuid).toUpperCase()] || null;
		},
		// Whose a 16-bit service number is, when it is a company's own, or null
		member: function (uuid16) { return members[hex4(uuid16)] || null; },
		// An appearance value: { category, name }, name the kind within the
		// category where the value says one; or null
		appearance: function (value) {
			var cat = looks[value >> 6], kind = looks[(value >> 6) + "." + (value & 63)];
			return cat ? { category: cat, name: kind || cat } : null;
		}
	};

	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else root.PirateBTNames = api;
})(typeof window !== "undefined" ? window : this);
