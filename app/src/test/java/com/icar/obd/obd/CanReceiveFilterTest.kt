package com.icar.obd.obd
import org.junit.Assert.*
import org.junit.Test
class CanReceiveFilterTest {
    @Test fun `valid standard extended and complete mask pairs normalize to same commands`() {
        assertEquals(listOf("ATCRA09A"),CanReceiveFilter.parse("09a").commands)
        assertEquals(listOf("ATCRA18DAF110"),CanReceiveFilter.parse("18daf110").commands)
        assertEquals(listOf("ATCM700","ATCF400"),CanReceiveFilter.parse("at cm 700; at cf 400").commands)
        assertEquals(listOf("ATCM000","ATCF000"),CanReceiveFilter.parse("ATCM000+ATCF000").commands)
    }
    @Test fun `arbitrary adapter operations incomplete pairs and multiple commands are denied`() {
        for(v in listOf("ATZ","ATMA","ATSH7E0","ATSP6","ATCF000","ATCM700","ATCRA09A+ATZ","ATCM700++ATCF400","09A\rATZ","１２３","800","20000000","ATCM700+ATCF18DAF110")) {
            val p=CanReceiveFilter.parse(v);assertNotNull(v,p.error);assertTrue(v,p.commands.isEmpty())
        }
    }
    @Test fun `empty only means unfiltered and unsafe input has explicit error`() {
        assertNull(CanReceiveFilter.parse(" ").error)
        assertTrue(CanReceiveFilter.parse("").commands.isEmpty())
        assertNotNull(CanReceiveFilter.parse("bad input").error)
    }
}
