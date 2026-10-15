package com.icar.obd.obd

/** Scanner-only strict extraction: never search arbitrary data for a service/ID pair. */
internal object PidScanResponse {
    fun data(raw: String, mode: String, pid: String): List<ByteArray> {
        val prefix = listOf(mode.toInt(16) + 0x40) + pid.chunked(2).map { it.toInt(16) }
        val payloads = mutableListOf<List<Int>>()
        val frames = linkedMapOf<String, MutableList<List<Int>>>()
        var indexed = mutableListOf<Int>()
        var expectedIndex = 0
        fun accept(b: List<Int>) {
            if (b.size > prefix.size && b.take(prefix.size) == prefix) payloads += b
        }
        raw.split('\r', '\n').forEach { original ->
            val line = original.replace(">", "").trim()
            val index = Regex("^([0-9A-Fa-f]):\\s*(.*)$").matchEntire(line)
            if (index != null) {
                val n = index.groupValues[1].toInt(16)
                val body = bytes(index.groupValues[2]) ?: return@forEach
                if (n == 0) { if (indexed.isNotEmpty()) accept(indexed); indexed = mutableListOf(); expectedIndex = 0 }
                if (n != expectedIndex) { indexed.clear(); expectedIndex = -1; return@forEach }
                indexed.addAll(body); expectedIndex++
                return@forEach
            }
            val tokens = line.split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (tokens.isEmpty()) return@forEach
            var header = ""
            var body = line
            if (tokens.size > 1 && tokens[0].matches(Regex("[0-9A-Fa-f]{3}|[0-9A-Fa-f]{8}"))) {
                header = tokens[0].uppercase(); body = tokens.drop(1).joinToString(" ")
                // ATD1 adds a one-nibble DLC between the CAN header and PCI.
                if(tokens.size>2 && tokens[1].matches(Regex("[0-8]"))) {
                    body=tokens.drop(2).joinToString(" ")
                    if(bytes(body)?.size!=tokens[1].toInt()) return@forEach
                }
            } else if(tokens.size==1 && line.matches(Regex("[0-9A-Fa-f]+")) && line.length%2==1 && line.length>=9) {
                val id=line.take(3)
                if(id.toInt(16)>0x7FF) return@forEach
                header=id.uppercase(); body=line.drop(3)
            }
            var b = bytes(body) ?: return@forEach
            if (b.isEmpty()) return@forEach
            // Four separated bytes are the extended CAN ID; three legacy header bytes
            // are accepted only for recognized response headers, never arbitrary offsets.
            if (header.isEmpty() && b.size > 5 && b[0] in 0x18..0x1B && b[1] in listOf(0xDA,0xDB)) {
                header=b.take(4).joinToString(); b=b.drop(4)
            } else if (header.isEmpty() && b.size > 3 && b[0] in listOf(0x48,0x68,0x86)) {
                header=b.take(3).joinToString(); b=b.drop(3)
            }
            when {
                b.take(prefix.size) == prefix -> accept(b)
                b[0] in 1..7 && b.size >= b[0]+1 -> accept(b.drop(1).take(b[0]))
                b[0] ushr 4 == 1 || b[0] ushr 4 == 2 -> frames.getOrPut(header) { mutableListOf() }.add(b)
            }
        }
        if (indexed.isNotEmpty()) accept(indexed)
        frames.values.forEach { group ->
            var current = mutableListOf<List<Int>>()
            fun flush() { if (current.isNotEmpty()) ObdProtocol.reassembleIsoTp(current)?.let(::accept); current=mutableListOf() }
            group.forEach { frame -> if(frame[0] ushr 4 == 1) flush(); current += frame }
            flush()
        }
        return payloads.map { p -> p.drop(prefix.size).map { it.toByte() }.toByteArray() }
    }
    private fun bytes(s: String): List<Int>? {
        if (!s.matches(Regex("[0-9A-Fa-f\\s]+"))) return null
        val hex=s.filterNot(Char::isWhitespace)
        if (hex.length%2 != 0) return null
        return hex.chunked(2).map { it.toInt(16) }
    }
}
