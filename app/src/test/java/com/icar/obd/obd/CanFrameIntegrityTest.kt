package com.icar.obd.obd
import org.junit.Assert.*
import org.junit.Test

class CanFrameIntegrityTest {
    @Test fun `corrupted payload is rejected instead of shifting later byte positions`() {
        assertNull(CanFrame.parseLine("09A 00 ZZ 04"))
        assertNull(CanFrame.parseLine("09A 00 0 04"))
    }
    @Test fun `out of range ID or oversized classic payload is rejected`() {
        assertNull(CanFrame.parseLine("20000000 00"))
        assertNull(CanFrame.parseLine("FFFF 00 01 02 03 04 05 06 07 08"))
    }
    @Test fun `valid standard extended and zero payload bytes remain supported`() {
        assertEquals(listOf(0,4), CanFrame.parseLine("09A 00 04")!!.data)
        assertEquals(0x18DAF110, CanFrame.parseLine("18DAF110 00 04")!!.canId)
        assertEquals(listOf(1,2),CanFrame.parseLine("4C1 2 01 02")!!.data)
        assertNull(CanFrame.parseLine("4C1 3 01 02"))
    }
}
