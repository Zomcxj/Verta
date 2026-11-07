// A ZIP an Office reader accepts, built in memory.
//
// A `.docx`, an `.xlsx` and a `.pptx` are all a ZIP of XML parts, and a probe needs a real one
// rather than a checked-in binary: the fixture's content is what the probe is asserting about, so
// it has to be readable in the probe.
//
// Entries are stored rather than deflated. Every reader here takes either, and a store is a header
// and the bytes, which is what keeps this a hundred lines instead of a compressor.

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** Names are UTF-8: a part named `数据` has to survive the round trip. */
const UTF8_NAME_FLAG = 0x0800;
/** A fixed DOS timestamp, so two builds of the same fixture are the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = 0x2821; // 2000-01-01

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 a ZIP entry carries. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The bytes of a ZIP holding the parts given.
 *
 * @param {Array<[string, string | Uint8Array]>} parts entry name and content, in archive order
 * @returns {Buffer}
 */
export function zip(parts) {
  const encoder = new TextEncoder();
  const entries = parts.map(([name, content]) => {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const nameBytes = encoder.encode(name);
    return { nameBytes, data, crc: crc32(data) };
  });

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_NAME_FLAG, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(entry.nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    const local = Buffer.concat([header, Buffer.from(entry.nameBytes), Buffer.from(entry.data)]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAME_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local);
    centrals.push(Buffer.concat([central, Buffer.from(entry.nameBytes)]));
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

/** What every Office package starts with: the root relationships and the content types. */
export function packageParts(officePart, contentType, officeRelationship) {
  return [
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${officeRelationship}" Target="${officePart}"/></Relationships>`,
    ],
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${contentType}</Types>`,
    ],
  ];
}
