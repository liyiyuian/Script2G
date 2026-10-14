// Demo: a long list that scrolls (made-up launches; a real script would fetch them through the bridge).
const launches = [
  ["Oct 16", "Starliner-2", "Cape Canaveral"], ["Oct 18", "Lunar Relay 1", "Kourou"],
  ["Oct 21", "Weather Sat 7", "Vandenberg"], ["Oct 23", "Crew Rotation 12", "Baikonur"],
  ["Oct 26", "Deep Space Probe", "Tanegashima"], ["Oct 29", "Comms Batch 40", "Cape Canaveral"],
  ["Nov 2", "Earth Observer", "Sriharikota"], ["Nov 5", "Cargo Run 31", "Wallops"],
  ["Nov 9", "Mars Orbiter", "Jiuquan"], ["Nov 12", "Rideshare 9", "Vandenberg"],
  ["Nov 15", "Ocean Monitor", "Kourou"], ["Nov 19", "Comms Batch 41", "Cape Canaveral"],
]
QuickLook.present("Next launches\n" + launches.map(([d, name, site]) => d + "  " + name + " · " + site).join("\n"))
