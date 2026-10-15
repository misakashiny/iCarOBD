package com.icar.obd.obd

import org.junit.Assert.*
import org.junit.Test

class PidScanResponseTest {
    private fun values(raw: String,mode: String="01",pid: String="0C")=PidScanResponse.data(raw,mode,pid).map { it.toList() }
    @Test fun `wrong IDs echoes and negative payload containing expected sequence are ignored`() {
        listOf("41 0D 41 0C 20", "01 0C", "7F 01 31 41 0C 20", "SEARCHING...", "NO DATA").forEach { assertTrue(it,values(it).isEmpty()) }
    }
    @Test fun `clean echo and noise do not contaminate a following positive response`() {
        assertEquals(listOf(listOf(16.toByte())),values("01 0C\rSEARCHING...\r410C10\r>"))
    }
    @Test fun `separate ECU responses stay separate and keep valid zero`() {
        assertEquals(listOf(listOf(0.toByte()),listOf(1.toByte())),values("41 0C 00\r41 0D 99\r41 0C 01"))
    }
    @Test fun `CAN11 and CAN29 single frames trim padding`() {
        assertEquals(listOf(listOf(0.toByte(),16.toByte())),values("7E8 04 41 0C 00 10 00 00 00"))
        assertEquals(listOf(listOf(0.toByte(),16.toByte())),values("18DAF110 04 41 0C 00 10 00 00 00"))
    }
    @Test fun `compact CAN11 and displayed DLC remain strict`() {
        assertEquals(listOf(listOf<Byte>(0,16)),values("7E804410C0010000000"))
        assertEquals(listOf(listOf<Byte>(0,16)),values("7E8 8 04 41 0C 00 10 00 00 00"))
        assertTrue(values("7E8 8 04 41 0D 00 10 00 00 00").isEmpty())
        assertTrue(values("7E8 1 04 41 0C 00 10 00 00 00").isEmpty())
    }
    @Test fun `CAN multi frame reassembly requires contiguous sequences`() {
        val first="7E8 10 0A 62 12 34 01 02 03\r"
        assertEquals(listOf(listOf<Byte>(1,2,3,4,5,6,7)),values(first+"7E8 21 04 05 06 07 00 00 00","22","1234"))
        assertTrue(values(first+"7E8 22 04 05 06 07 00 00 00","22","1234").isEmpty())
        assertTrue(values(first,"22","1234").isEmpty())
    }
    @Test fun `ELM indexed multiline verifies ID before joining data`() {
        assertEquals(listOf(listOf<Byte>(1,2,3,4)),values("006\r0: 49 02 01 02\r1: 03 04","09","02"))
        assertTrue(values("0: 49 03 01 02\r1: 49 02 03","09","02").isEmpty())
        assertTrue(values("0: 49 02 01 02\r2: 03 04","09","02").isEmpty())
    }
}
